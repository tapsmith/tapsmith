package dev.tapsmith.agent

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Routes incoming JSON commands to the appropriate handler.
 *
 * JSON protocol:
 *   Request:  {"id": "uuid", "method": "methodName", "params": {...}}
 *   Response: {"id": "uuid", "result": {...}}
 *         or: {"id": "uuid", "error": {"type": "...", "message": "..."}}
 */
class CommandHandler(
    private val context: Context,
    private val device: UiDevice,
    private val elementFinder: ElementFinder,
    private val actionExecutor: ActionExecutor,
    private val waitEngine: WaitEngine,
    private val hierarchyDumper: HierarchyDumper,
) {
    companion object {
        private const val TAG = "TapsmithCommand"
    }

    /** Cache of last clipboard text set via setClipboard, used as fallback on Android 13+. */
    @Volatile
    private var lastClipboardText = ""

    fun handle(rawJson: String): String {
        val json =
            try {
                JSONObject(rawJson)
            } catch (e: Exception) {
                return errorResponse(null, "PARSE_ERROR", "Invalid JSON: ${e.message}")
            }

        val id = json.optString("id", null)
        val method = json.optString("method", null)
        if (method == null) {
            return errorResponse(id, "INVALID_REQUEST", "Missing 'method' field")
        }

        val params = json.optJSONObject("params") ?: JSONObject()

        val start = SystemClock.uptimeMillis()
        return try {
            val result = dispatch(method, params, actionBudget(params, start))
            successResponse(id, result)
        } catch (e: ElementCoveredException) {
            errorResponse(id, "ELEMENT_COVERED", e.message ?: "Element is covered")
        } catch (e: TargetChangedException) {
            // "stale": the SDK re-resolves an id-addressed handle.
            errorResponse(id, "ELEMENT_NOT_FOUND", e.message ?: "Element changed")
        } catch (e: TouchTooLateException) {
            errorResponse(id, "ACTION_FAILED", e.message ?: "Ran out of time")
        } catch (e: ElementNotFoundException) {
            errorResponse(id, "ELEMENT_NOT_FOUND", e.message ?: "Element not found")
        } catch (e: TimeoutException) {
            errorResponse(id, "TIMEOUT", e.message ?: "Operation timed out")
        } catch (e: InvalidSelectorException) {
            errorResponse(id, "INVALID_SELECTOR", e.message ?: "Invalid selector")
        } catch (e: ActionFailedException) {
            errorResponse(id, "ACTION_FAILED", e.message ?: "Action failed")
        } catch (e: StaleObjectException) {
            errorResponse(id, "ELEMENT_NOT_FOUND", "Element is stale (UI changed): ${e.message}")
        } catch (e: Exception) {
            // Defense in depth: reflection anywhere in the dispatch can wrap
            // the real failure in an InvocationTargetException whose message
            // is null. Unwrap so a stale element still maps to the typed,
            // SDK-retryable response, and so no error ever surfaces as a
            // bare "Unknown error".
            val cause = (e as? java.lang.reflect.InvocationTargetException)?.targetException ?: e
            if (cause is StaleObjectException) {
                return errorResponse(id, "ELEMENT_NOT_FOUND", "Element is stale (UI changed): ${cause.message}")
            }
            Log.e(TAG, "Error handling method '$method'", cause)
            errorResponse(id, "INTERNAL_ERROR", cause.message ?: cause.javaClass.name)
        } finally {
            // Per-command timing so per-phase stacking (resolve / settle /
            // stable-bounds / inject, logged by WaitEngine/ActionExecutor) can
            // be correlated against the daemon's action budget (PILOT-278).
            Log.d(TAG, "$method handled in ${SystemClock.uptimeMillis() - start}ms")
        }
    }

    /**
     * The time an element action may spend, counted from the command's
     * arrival: its `timeout` and the daemon's `readTimeoutMs`, stamped on every
     * command — past it the daemon has given up, and a touch then would land
     * in the middle of whatever the test does next (PILOT-362). The daemon
     * sends no `timeout` for an explicit zero (no-wait) one, so a missing
     * `timeout` means no waiting for a cover — a single check, as on iOS. (The
     * selector wait keeps its own 10 s default for a missing `timeout`.)
     */
    private fun actionBudget(
        params: JSONObject,
        startMs: Long,
    ): ActionBudget {
        val readTimeoutMs = params.optLong("readTimeoutMs", 0L)
        return ActionBudget(
            startMs = startMs,
            timeoutMs = params.optLong("timeout", 0L),
            readDeadlineMs = if (readTimeoutMs > 0) startMs + readTimeoutMs else null,
        )
    }

    /**
     * An element resolved for action execution.
     *
     * [freshBounds] is non-null only when resolution ran a selector wait just
     * now — WaitEngine has already settle-checked those bounds, so actions can
     * compute tap coordinates from them without re-reading the node (each read
     * is a blocking accessibility round-trip on the app's main looper;
     * PILOT-278). Cached-elementId resolution performs no reads and leaves it
     * null; actions then run their own bounded stability check.
     */
    private class ResolvedElement(
        val obj: UiObject2,
        val freshBounds: Rect?,
        /** What identified the element when it was found, re-checked before
         *  it is touched (PILOT-362). */
        val identity: TargetIdentity?,
    )

    /**
     * Resolve an element from params, supporting both elementId (cached) and
     * selector-based lookup with auto-waiting.
     */
    private fun resolveElement(
        params: JSONObject,
        timeout: Long = params.optLong("timeout", 10000L),
    ): ResolvedElement {
        val elementId = params.optString("elementId", null)
        if (!elementId.isNullOrEmpty()) {
            // Use the cached element directly — a pure cache lookup, zero
            // accessibility round-trips. (This used to route through
            // getElementInfo(), re-reading every attribute — ~a dozen blocking
            // a11y calls, each able to stall for seconds on a busy app — only
            // for every caller to discard all of it but the id; PILOT-278.)
            return ResolvedElement(
                elementFinder.getElement(elementId),
                freshBounds = null,
                identity = elementFinder.identityOf(elementId),
            )
        }
        // Selector-based: auto-wait then find
        val selector = parseSelectorParams(params)
        val info = waitEngine.waitForElement(selector, timeout, elementFinder)
        return ResolvedElement(elementFinder.getElement(info.elementId), info.bounds, elementFinder.identityOf(info.elementId))
    }

    /**
     * Resolve the element and run [action] on it. When the resolved node turns
     * out to show another element by the time it is touched (React reuses a
     * native view for what it renders next in the same place — PILOT-362), a
     * selector-addressed action resolves its selector again within what is
     * left of the budget, like a Playwright locator, which re-resolves on
     * every attempt. An id-addressed one fails as stale, and the SDK
     * re-resolves it.
     */
    private fun <T> actOnElement(
        params: JSONObject,
        budget: ActionBudget,
        action: (ResolvedElement) -> T,
    ): T {
        var element = resolveElement(params)
        while (true) {
            try {
                return action(element)
            } catch (e: TargetChangedException) {
                val idAddressed = !params.optString("elementId", null).isNullOrEmpty()
                if (idAddressed || budget.remainingMs <= 0) throw e
                Log.d(TAG, "resolved element changed into another before it was touched; resolving again")
                element = resolveElement(params, timeout = budget.remainingMs)
            }
        }
    }

    /**
     * Resolve one end of a drag (source/target) from its params: a cached
     * elementId when present, else a selector resolved against the given
     * timeout. Mirrors [resolveElement] but the timeout lives on the parent
     * dragAndDrop command, not these nested objects.
     */
    private fun resolveDragEnd(
        params: JSONObject,
        timeout: Long,
    ): ResolvedElement {
        val elementId = params.optString("elementId", null)
        if (!elementId.isNullOrEmpty()) {
            return ResolvedElement(elementFinder.getElement(elementId), freshBounds = null, elementFinder.identityOf(elementId))
        }
        val info = waitEngine.waitForElement(parseSelectorParams(params), timeout, elementFinder)
        return ResolvedElement(elementFinder.getElement(info.elementId), info.bounds, elementFinder.identityOf(info.elementId))
    }

    private fun dispatch(
        method: String,
        params: JSONObject,
        budget: ActionBudget,
    ): JSONObject {
        return when (method) {
            "findElement" -> {
                val selector = parseSelectorParams(params)
                val parentId = params.optString("parentId", null)
                val timeout = params.optLong("timeout", 10000L)
                // Auto-wait for element if timeout > 0
                val element =
                    if (timeout > 0 && parentId == null) {
                        waitEngine.waitForElement(selector, timeout, elementFinder)
                    } else {
                        elementFinder.findElement(selector, parentId)
                    }
                element.toJson()
            }

            "findElements" -> {
                val selector = parseSelectorParams(params)
                val parentId = params.optString("parentId", null)
                val elements = elementFinder.findElements(selector, parentId)
                JSONObject().put(
                    "elements",
                    elements.map { it.toJson() }.toTypedArray().let {
                        org.json.JSONArray(it)
                    },
                )
            }

            "tap" -> {
                val x = params.optInt("x", -1)
                val y = params.optInt("y", -1)
                if (x >= 0 && y >= 0) {
                    actionExecutor.tapCoordinates(x, y)
                } else {
                    actOnElement(params, budget) { element ->
                        actionExecutor.tap(element.obj, element.freshBounds, budget, element.identity)
                    }
                }
                JSONObject().put("success", true)
            }

            // waitForElement is used by the daemon to auto-wait + find + tap
            "waitForElement" -> {
                val selector = parseSelectorParams(params)
                val timeout = params.optLong("timeout", 10000L)
                val element = waitEngine.waitForElement(selector, timeout, elementFinder)
                // After waiting, tap the element — reusing the settle-checked
                // bounds from the wait, so the tap adds no further a11y reads.
                actionExecutor.tap(
                    elementFinder.getElement(element.elementId),
                    element.bounds,
                    budget,
                    elementFinder.identityOf(element.elementId),
                )
                JSONObject().put("success", true).put("element", element.toJson())
            }

            "longPress" -> {
                val duration = params.optLong("duration", 1000L)
                val x = params.optInt("x", -1)
                val y = params.optInt("y", -1)
                if (x >= 0 && y >= 0) {
                    actionExecutor.longPressCoordinates(x, y, duration)
                } else {
                    actOnElement(params, budget) { element ->
                        actionExecutor.longPress(element.obj, duration, element.freshBounds, budget, element.identity)
                    }
                }
                JSONObject().put("success", true)
            }

            "typeText" -> {
                val text = params.getString("text")
                // Every selector key the daemon can serialize must be listed:
                // a missing key silently degrades targeted typing to the
                // blind key-event fallback below, which races the IME's
                // input-session restart and drops leading characters under
                // load (the "label" omission caused exactly that).
                val selectorKeys =
                    listOf(
                        "role",
                        "id",
                        "resourceId",
                        "contentDesc",
                        "className",
                        "testId",
                        "hint",
                        "label",
                        "textContains",
                        "xpath",
                        "parent",
                        "elementId",
                    )
                val hasSelector = selectorKeys.any(params::has)
                if (hasSelector) {
                    // Remove "text" from params before resolving selector, since "text" here
                    // is the value to type, not a text selector. Without this, parseSelectorParams
                    // would treat the typed value as a text match criterion.
                    val selectorParams = JSONObject(params.toString())
                    selectorParams.remove("text")
                    actOnElement(selectorParams, budget) { element ->
                        actionExecutor.typeText(element.obj, text, element.freshBounds, budget, element.identity)
                    }
                } else {
                    actionExecutor.typeTextWithoutFocus(text)
                }
                JSONObject().put("success", true)
            }

            "clearText" -> {
                actOnElement(params, budget) { element ->
                    actionExecutor.clearText(element.obj, budget, element.identity)
                }
                JSONObject().put("success", true)
            }

            "swipe" -> {
                if (params.has("fromX")) {
                    val x1 = params.getInt("fromX")
                    val y1 = params.getInt("fromY")
                    val x2 = params.getInt("toX")
                    val y2 = params.getInt("toY")
                    val durationMs = params.optLong("durationMs", 300L)
                    actionExecutor.swipeCoordinates(x1, y1, x2, y2, durationMs)
                } else {
                    val direction = params.getString("direction")
                    val speed = params.optInt("speed", 5000)
                    val distance = params.optDouble("distance", 0.5)
                    val elementId = params.optString("elementId", null)
                    if (elementId != null) {
                        actionExecutor.swipe(elementFinder.getElement(elementId), direction, speed, distance)
                    } else if (params.has("startElement")) {
                        val startSel = parseSelectorParams(params.getJSONObject("startElement"))
                        val startEl = waitEngine.waitForElement(startSel, 10000L, elementFinder)
                        actionExecutor.swipe(elementFinder.getElement(startEl.elementId), direction, speed, distance)
                    } else {
                        actionExecutor.swipeScreen(direction, speed, distance)
                    }
                }
                JSONObject().put("success", true)
            }

            "scroll" -> {
                val direction = params.getString("direction")
                val targetSelector =
                    if (params.has("scrollTo")) {
                        parseSelectorParams(params.getJSONObject("scrollTo"))
                    } else {
                        null
                    }
                if (params.has("container")) {
                    val containerSel = parseSelectorParams(params.getJSONObject("container"))
                    val containerEl = waitEngine.waitForElement(containerSel, 10000L, elementFinder)
                    actionExecutor.scroll(elementFinder.getElement(containerEl.elementId), direction, targetSelector)
                } else if (params.has("elementId")) {
                    val elementId = params.getString("elementId")
                    actionExecutor.scroll(elementFinder.getElement(elementId), direction, targetSelector)
                } else {
                    actionExecutor.scrollScreen(direction, targetSelector)
                }
                JSONObject().put("success", true)
            }

            "touchDown" -> {
                actionExecutor.touchDown(params.optInt("x", 0), params.optInt("y", 0))
                JSONObject().put("success", true)
            }

            "touchMove" -> {
                actionExecutor.touchMove(params.optInt("x", 0), params.optInt("y", 0))
                JSONObject().put("success", true)
            }

            "touchUp" -> {
                actionExecutor.touchUp(params.optInt("x", 0), params.optInt("y", 0))
                JSONObject().put("success", true)
            }

            "touchCancel" -> {
                actionExecutor.touchCancel()
                JSONObject().put("success", true)
            }

            "pressKey" -> {
                val key = params.getString("key")
                actionExecutor.pressKey(key)
                JSONObject().put("success", true)
            }

            "getUiHierarchy" -> {
                val xml = hierarchyDumper.dump()
                JSONObject().put("hierarchy", xml)
            }

            "waitForIdle" -> {
                val timeout = params.optLong("timeout", 5000L)
                waitEngine.waitForIdle(timeout)
                JSONObject().put("success", true)
            }

            "waitForElement" -> {
                val selector = parseSelectorParams(params)
                val timeout = params.optLong("timeout", 10000L)
                val element = waitEngine.waitForElement(selector, timeout, elementFinder)
                element.toJson()
            }

            "screenshot" -> {
                val quality = params.optInt("quality", 80)
                val base64 = captureScreenshot(quality)
                JSONObject().put("data", base64).put("format", "png")
            }

            "doubleTap" -> {
                val intervalMs = params.optLong("intervalMs", 0)
                actOnElement(params, budget) { element ->
                    actionExecutor.doubleTap(element.obj, intervalMs, element.freshBounds, budget, element.identity)
                }
                JSONObject().put("success", true)
            }

            "dragAndDrop" -> {
                val sourceParams = params.getJSONObject("source")
                val targetParams = params.getJSONObject("target")
                val timeout = params.optLong("timeout", 10000L)
                // Each end may be a cached elementId (positional/filtered handle)
                // or a selector to resolve.
                val sourceEl = resolveDragEnd(sourceParams, timeout)
                val targetEl = resolveDragEnd(targetParams, timeout)
                actionExecutor.dragTo(sourceEl.obj, targetEl.obj)
                JSONObject().put("success", true)
            }

            "selectOption" -> {
                val optionText = params.optString("option", null)
                val index = if (params.has("index")) params.getInt("index") else -1
                if (optionText == null && index < 0) {
                    throw InvalidSelectorException("selectOption requires either 'option' (string) or 'index' (int)")
                }
                actOnElement(params, budget) { element ->
                    if (optionText != null) {
                        actionExecutor.selectOption(element.obj, optionText, budget, element.identity)
                    } else {
                        actionExecutor.selectOptionByIndex(element.obj, index, budget, element.identity)
                    }
                }
                JSONObject().put("success", true)
            }

            "pinchZoom" -> {
                val element = resolveElement(params)
                val scale = params.optDouble("scale", 1.0).toFloat()
                actionExecutor.pinchZoom(element.obj, scale)
                JSONObject().put("success", true)
            }

            "focus" -> {
                actOnElement(params, budget) { element ->
                    actionExecutor.focus(element.obj, budget, element.identity)
                }
                JSONObject().put("success", true)
            }

            "blur" -> {
                val element = resolveElement(params)
                actionExecutor.blur(element.obj)
                JSONObject().put("success", true)
            }

            "highlight" -> {
                val element = resolveElement(params)
                val duration = params.optLong("duration", 1000L)
                actionExecutor.highlight(element.obj, duration)
                JSONObject().put("success", true)
            }

            "elementScreenshot" -> {
                val element = resolveElement(params)
                // A screenshot must reflect the element's current position, so
                // prefer resolve-time bounds only when they are fresh.
                val bounds = element.freshBounds?.takeIf { !it.isEmpty } ?: element.obj.visibleBounds

                // Take full screenshot and crop to element bounds
                val base64 = captureElementScreenshot(bounds)
                JSONObject().put("data", base64).put("format", "png")
            }

            "setClipboard" -> {
                val text = params.getString("text")
                lastClipboardText = text
                // Use ClipboardManager on the main thread to set clipboard.
                // Set requires the main looper but doesn't need focus on Android 13+.
                runOnMainThread {
                    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    val clip = ClipData.newPlainText("tapsmith", text)
                    clipboard.setPrimaryClip(clip)
                }
                JSONObject().put("success", true)
            }

            "getClipboard" -> {
                // On Android 13+ (API 33+), only the focused/IME app can read clipboard
                // via ClipboardManager. The instrumentation context is not focused, so
                // we read clipboard via the Instrumentation's own ClipboardManager which
                // runs in the instrumented app's context. As a workaround, we store
                // the last-set clipboard text in memory.
                val clipboardText =
                    runOnMainThread {
                        try {
                            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                            clipboard.primaryClip?.getItemAt(0)?.text?.toString() ?: ""
                        } catch (e: Exception) {
                            Log.w(TAG, "ClipboardManager read failed: ${e.message}")
                            ""
                        }
                    }
                // If ClipboardManager failed (Android 13+ restriction), fall back to cached value
                val text = clipboardText.ifEmpty { lastClipboardText }
                JSONObject().put("text", text)
            }

            "clearElementCache" -> {
                elementFinder.clearElementCache()
                JSONObject().put("success", true)
            }

            "ping" -> {
                JSONObject().put("pong", true)
            }

            else -> throw ActionFailedException("Unknown method: $method")
        }
    }

    private fun parseSelectorParams(params: JSONObject): ElementSelector {
        // Handle "role" which can be either a string or a {"role": "...", "name": "..."} object
        val roleObj = params.opt("role")
        val source = if (roleObj is JSONObject) roleObj else params
        val role = source.optString("role", null)?.ifEmpty { null }
        val name = source.optString("name", null)?.ifEmpty { null }

        // Handle "resourceId" (sent by daemon) or "id" (legacy)
        val resourceId = params.optString("resourceId", null) ?: params.optString("id", null)

        return ElementSelector(
            role = role,
            name = name,
            text = params.optString("text", null),
            textContains = params.optString("textContains", null),
            contentDesc = params.optString("contentDesc", null),
            hint = params.optString("hint", null),
            className = params.optString("className", null),
            testId = params.optString("testId", null),
            id = resourceId,
            xpath = params.optString("xpath", null),
            label = params.optString("label", null),
            enabled = if (params.has("enabled")) params.getBoolean("enabled") else null,
            checked = if (params.has("checked")) params.getBoolean("checked") else null,
            focused = if (params.has("focused")) params.getBoolean("focused") else null,
            selected = if (params.has("selected")) params.getBoolean("selected") else null,
            expanded = if (params.has("expanded")) params.getBoolean("expanded") else null,
        )
    }

    /** Run a block on the main thread and wait for it to complete. */
    private fun <T> runOnMainThread(block: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return block()
        } else {
            val latch = CountDownLatch(1)
            val result = AtomicReference<Result<T>>()
            Handler(Looper.getMainLooper()).post {
                try {
                    result.set(Result.success(block()))
                } catch (e: Exception) {
                    result.set(Result.failure(e))
                } finally {
                    latch.countDown()
                }
            }
            if (!latch.await(5, TimeUnit.SECONDS)) {
                throw TimeoutException("runOnMainThread timed out after 5 seconds")
            }
            return result.get().getOrThrow()
        }
    }

    private fun captureElementScreenshot(bounds: android.graphics.Rect): String {
        val tmpFile = java.io.File.createTempFile("tapsmith_screenshot", ".png")
        try {
            // Scale 1.0 for full resolution; quality is ignored for PNG format
            val success = device.takeScreenshot(tmpFile, 1.0f, 100)
            if (!success) {
                throw ActionFailedException("Failed to capture screenshot")
            }

            // Crop to element bounds — guard against OOM on large screenshots
            val fullBitmap =
                try {
                    android.graphics.BitmapFactory.decodeFile(tmpFile.absolutePath)
                        ?: throw ActionFailedException("Failed to decode screenshot")
                } catch (e: OutOfMemoryError) {
                    throw ActionFailedException("Screenshot too large to decode: ${e.message}")
                }

            val cropLeft = bounds.left.coerceAtLeast(0)
            val cropTop = bounds.top.coerceAtLeast(0)
            val cropWidth = (bounds.width()).coerceAtMost(fullBitmap.width - cropLeft)
            val cropHeight = (bounds.height()).coerceAtMost(fullBitmap.height - cropTop)

            if (cropWidth <= 0 || cropHeight <= 0) {
                fullBitmap.recycle()
                throw ActionFailedException("Element bounds are outside the screen")
            }

            val cropped = android.graphics.Bitmap.createBitmap(fullBitmap, cropLeft, cropTop, cropWidth, cropHeight)
            fullBitmap.recycle()

            val outputStream = java.io.ByteArrayOutputStream()
            cropped.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, outputStream)
            cropped.recycle()

            return Base64.encodeToString(outputStream.toByteArray(), Base64.NO_WRAP)
        } finally {
            tmpFile.delete()
        }
    }

    private fun captureScreenshot(quality: Int): String {
        val tmpFile = java.io.File.createTempFile("tapsmith_screenshot", ".png")
        try {
            val success = device.takeScreenshot(tmpFile, 1.0f, quality)
            if (!success) {
                throw ActionFailedException("Failed to capture screenshot")
            }
            val bytes = tmpFile.readBytes()
            return Base64.encodeToString(bytes, Base64.NO_WRAP)
        } finally {
            tmpFile.delete()
        }
    }

    private fun successResponse(
        id: String?,
        result: JSONObject,
    ): String {
        return JSONObject().apply {
            put("id", id ?: JSONObject.NULL)
            put("result", result)
        }.toString()
    }

    private fun errorResponse(
        id: String?,
        type: String,
        message: String,
    ): String {
        return JSONObject().apply {
            put("id", id ?: JSONObject.NULL)
            put(
                "error",
                JSONObject().apply {
                    put("type", type)
                    put("message", message)
                },
            )
        }.toString()
    }
}

// Custom exceptions for structured error handling
class ElementNotFoundException(message: String) : RuntimeException(message)

class TimeoutException(message: String) : RuntimeException(message)

class InvalidSelectorException(message: String) : RuntimeException(message)

class ActionFailedException(message: String) : RuntimeException(message)
