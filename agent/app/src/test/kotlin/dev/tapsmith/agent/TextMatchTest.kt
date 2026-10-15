package dev.tapsmith.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Host-side tests for whitespace-normalized text matching (PILOT-510). */
class TextMatchTest {
    private fun exact(
        query: String,
        text: String,
    ) = TextMatch.exactPattern(query).matcher(text).matches()

    private fun contains(
        query: String,
        text: String,
    ) = TextMatch.containsPattern(query).matcher(text).matches()

    @Test
    fun `normalize collapses unicode whitespace runs and trims`() {
        assertEquals("Welcome to Expo", TextMatch.normalize("Welcome to Expo"))
        assertEquals("a b c", TextMatch.normalize("  a    b\n\tc 　"))
        assertEquals("line one line two", TextMatch.normalize("line one\nline two"))
        assertEquals("", TextMatch.normalize("  \n "))
        assertEquals("a​b", TextMatch.normalize("a​b"))
    }

    @Test
    fun `exact pattern matches across whitespace variants`() {
        assertTrue(exact("Welcome to Expo", "Welcome to Expo"))
        assertTrue(exact("Welcome to Expo", "Welcome to Expo"))
        assertTrue(exact("Welcome  to Expo ", "Welcome to Expo"))
        assertTrue(exact("Line one Line two", "Line one\nLine two"))
        assertTrue(exact("a b", " a ﻿b\r\n"))
    }

    @Test
    fun `exact pattern still requires the whole text`() {
        assertFalse(exact("Welcome to", "Welcome to Expo"))
        assertFalse(exact("WelcometoExpo", "Welcome to Expo"))
        assertFalse(exact("Welcome to Expo", "welcome to expo"))
    }

    @Test
    fun `contains pattern matches a substring across whitespace variants`() {
        assertTrue(contains("to Expo", "Welcome to Expo"))
        assertTrue(contains("Welcome", "Welcome to Expo"))
        assertTrue(contains(" to  Expo ", "Welcome to Expo!"))
        assertTrue(contains("one Line", "Line one\nLine two"))
        assertFalse(contains("to Expos", "Welcome to Expo"))
    }

    @Test
    fun `contains pattern ignores case, as Playwright's non-exact getByText does (PILOT-522)`() {
        // RN's textTransform: 'uppercase' renders "Get started" as "GET STARTED".
        assertTrue(contains("get started", "GET STARTED"))
        assertTrue(contains("Started", "get started now"))
        assertTrue(contains("wElCoMe  TO", "Welcome to\nExpo"))
        // Non-ASCII letters fold too.
        assertTrue(contains("école", "ÉCOLE NORMALE"))
        assertTrue(contains("ΣΟΦΙΑ", "σοφια"))
        assertFalse(contains("get startedx", "GET STARTED"))
        // Metacharacters stay literal with the case-insensitive flag.
        assertTrue(contains("[BETA]*", "try [beta]* now"))
    }

    @Test
    fun `contains pattern case folding ignores the default locale`() {
        val saved = java.util.Locale.getDefault()
        try {
            java.util.Locale.setDefault(java.util.Locale.forLanguageTag("tr"))
            assertTrue(contains("login", "LOGIN"))
            assertTrue(contains("LOGIN", "login"))
        } finally {
            java.util.Locale.setDefault(saved)
        }
    }

    @Test
    fun `regex metacharacters in the query are literal`() {
        assertTrue(exact("Total: $5.00 (x)", "Total: $5.00 (x)"))
        assertFalse(exact("a.c", "abc"))
        assertTrue(contains("[beta]*", "Try [beta]* now"))
        assertFalse(contains("a+", "aaa"))
        assertTrue(exact("\\Q\\E", "\\Q\\E"))
    }

    @Test
    fun `empty and whitespace-only queries`() {
        assertTrue(exact("", ""))
        assertTrue(exact(" ", " "))
        assertFalse(exact("", "x"))
        assertTrue(contains("", "anything"))
        assertTrue(contains(" ", ""))
    }

    @Test
    fun `equalsNormalized compares normalized forms and tolerates null`() {
        assertTrue(TextMatch.equalsNormalized("Save draft", "Save draft"))
        assertTrue(TextMatch.equalsNormalized(" Save draft", "Save  draft"))
        assertFalse(TextMatch.equalsNormalized(null, "Save draft"))
        assertFalse(TextMatch.equalsNormalized("Save drafts", "Save draft"))
    }

    @Test
    fun `accessible name matches case-insensitive substrings by default (PILOT-549)`() {
        // RN's <Button title="Sign In"> renders "SIGN IN" on Android.
        assertTrue(TextMatch.nameMatches("SIGN IN", "Sign In", exact = false))
        assertTrue(TextMatch.nameMatches("Explore the app", "explor", exact = false))
        assertTrue(TextMatch.nameMatches("Welcome to Expo", "TO  expo", exact = false))
        assertFalse(TextMatch.nameMatches("Sign out", "Sign in", exact = false))
        assertFalse(TextMatch.nameMatches(null, "Sign in", exact = false))
    }

    @Test
    fun `exact accessible name is case-sensitive and whole-string, whitespace-normalized`() {
        assertTrue(TextMatch.nameMatches(" Sign  In ", "Sign In", exact = true))
        assertFalse(TextMatch.nameMatches("SIGN IN", "Sign In", exact = true))
        assertFalse(TextMatch.nameMatches("Sign In now", "Sign In", exact = true))
        assertFalse(TextMatch.nameMatches(null, "Sign In", exact = true))
    }

    @Test
    fun `case folding ignores the default locale`() {
        val saved = java.util.Locale.getDefault()
        try {
            java.util.Locale.setDefault(java.util.Locale.forLanguageTag("tr"))
            assertTrue(TextMatch.nameMatches("LOGIN", "login", exact = false))
        } finally {
            java.util.Locale.setDefault(saved)
        }
    }

    @Test
    fun `an editable field's typed value is not a substring accessible name`() {
        fun matches(
            text: String,
            textIsValue: Boolean,
        ) = TextMatch.accessibleNameMatches(null, text, textIsValue, { null }, "Email", exact = false)
        assertFalse(matches("email me later", textIsValue = true))
        assertTrue(matches("Email", textIsValue = true))
        // An empty field's hint, or any non-editable text, is a name.
        assertTrue(matches("Your EMAIL address", textIsValue = false))
        assertTrue(
            TextMatch.accessibleNameMatches("Email address", "x", true, { null }, "email", exact = false),
        )
    }
}
