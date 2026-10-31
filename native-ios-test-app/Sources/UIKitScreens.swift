import SwiftUI
import UIKit

// UIKit counterparts of the SwiftUI screens. Each is a plain view controller
// hosted through UIViewControllerRepresentable, so its accessibility tree is
// the one a UIKit app produces (a hosted controller isn't re-described by
// SwiftUI).

struct UIKitScreen<Controller: UIViewController>: UIViewControllerRepresentable {
    let make: () -> Controller
    func makeUIViewController(context: Context) -> Controller { make() }
    func updateUIViewController(_ controller: Controller, context: Context) {}
}

private func makeLabel(_ text: String) -> UILabel {
    let label = UILabel()
    label.text = text
    return label
}

private func makeStack(_ views: [UIView], axis: NSLayoutConstraint.Axis = .vertical) -> UIStackView {
    let stack = UIStackView(arrangedSubviews: views)
    stack.axis = axis
    stack.spacing = axis == .vertical ? 20 : 12
    stack.alignment = axis == .vertical ? .fill : .center
    return stack
}

private func pin(_ content: UIView, in view: UIView) {
    content.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(content)
    NSLayoutConstraint.activate([
        content.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
        content.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
        content.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
    ])
}

// ─── Controls ───

final class UIKitControlsViewController: UIViewController {
    private let wifiStatus = makeLabel("Wi-Fi: off")
    private let bluetoothStatus = makeLabel("Bluetooth: on")
    private let sizeStatus = makeLabel("Size: Medium")
    private let countLabel = makeLabel("Count: 0")
    private let submitStatus = makeLabel("Not submitted")

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        // Labelled switch: the accessible pattern.
        let wifi = UISwitch()
        wifi.accessibilityLabel = "Wi-Fi"
        wifi.addAction(UIAction { [weak self] action in
            self?.wifiStatus.text = "Wi-Fi: \((action.sender as! UISwitch).isOn ? "on" : "off")"
        }, for: .valueChanged)

        // Unlabelled switch beside a label: the common pattern in UIKit apps.
        let bluetooth = UISwitch()
        bluetooth.isOn = true
        bluetooth.addAction(UIAction { [weak self] action in
            self?.bluetoothStatus.text = "Bluetooth: \((action.sender as! UISwitch).isOn ? "on" : "off")"
        }, for: .valueChanged)

        let size = UISegmentedControl(items: ["Small", "Medium", "Large"])
        size.selectedSegmentIndex = 1
        size.addAction(UIAction { [weak self] action in
            let control = action.sender as! UISegmentedControl
            self?.sizeStatus.text = "Size: \(control.titleForSegment(at: control.selectedSegmentIndex) ?? "")"
        }, for: .valueChanged)

        let stepper = UIStepper()
        stepper.accessibilityLabel = "Count"
        stepper.addAction(UIAction { [weak self] action in
            self?.countLabel.text = "Count: \(Int((action.sender as! UIStepper).value))"
        }, for: .valueChanged)

        var config = UIButton.Configuration.filled()
        config.title = "Submit"
        let submit = UIButton(configuration: config)
        submit.addAction(UIAction { [weak self] _ in self?.submitStatus.text = "Submitted" }, for: .touchUpInside)

        pin(makeStack([
            makeStack([makeLabel("Wi-Fi"), UIView(), wifi], axis: .horizontal),
            wifiStatus,
            makeStack([makeLabel("Bluetooth"), UIView(), bluetooth], axis: .horizontal),
            bluetoothStatus,
            size,
            sizeStatus,
            makeStack([countLabel, UIView(), stepper], axis: .horizontal),
            submit,
            submitStatus,
        ]), in: view)
    }
}

// ─── Table ───

final class UIKitTableViewController: UITableViewController {
    private var rows = (1...100).map { "Row \($0)" }
    private let selection = makeLabel("Nothing selected")

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "cell")
        selection.accessibilityIdentifier = "uikit-table-selection"
        selection.textAlignment = .center
        selection.frame = CGRect(x: 0, y: 0, width: 0, height: 44)
        tableView.tableHeaderView = selection
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { rows.count }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "cell", for: indexPath)
        var content = cell.defaultContentConfiguration()
        content.text = rows[indexPath.row]
        cell.contentConfiguration = content
        // Every row a disclosure chevron, except a few with UIKit's other
        // accessories, keyed by text so a deleted row doesn't move them.
        cell.accessoryView = nil
        switch rows[indexPath.row] {
        case "Row 6": cell.accessoryType = .detailDisclosureButton
        case "Row 7": cell.accessoryType = .checkmark
        case "Row 8":
            // A custom accessory: a real button that is disabled.
            let buy = UIButton(type: .system)
            buy.setTitle("Buy", for: .normal)
            buy.isEnabled = false
            buy.sizeToFit()
            cell.accessoryView = buy
        case "Row 9":
            // A custom accessory drawn like UIKit's checkmark: an image-only
            // button, disabled (XCUITest labels it "selected").
            let done = UIButton(type: .system)
            done.setImage(UIImage(systemName: "checkmark"), for: .normal)
            done.isEnabled = false
            done.sizeToFit()
            cell.accessoryView = done
        default: cell.accessoryType = .disclosureIndicator
        }
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        selection.text = "Selected: \(rows[indexPath.row])"
    }

    override func tableView(
        _ tableView: UITableView,
        trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath
    ) -> UISwipeActionsConfiguration? {
        let delete = UIContextualAction(style: .destructive, title: "Delete") { [weak self] _, _, done in
            self?.rows.remove(at: indexPath.row)
            tableView.deleteRows(at: [indexPath], with: .automatic)
            done(true)
        }
        return UISwipeActionsConfiguration(actions: [delete])
    }
}

// ─── Dialogs ───

final class UIKitDialogsViewController: UIViewController {
    private let result = makeLabel("Result: None")

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let alertButton = UIButton(type: .system)
        alertButton.setTitle("UIKit Alert", for: .normal)
        alertButton.addAction(UIAction { [weak self] _ in self?.showAlert() }, for: .touchUpInside)

        let sheetButton = UIButton(type: .system)
        sheetButton.setTitle("UIKit Action Sheet", for: .normal)
        sheetButton.addAction(UIAction { [weak self] action in
            self?.showSheet(from: action.sender as! UIView)
        }, for: .touchUpInside)

        pin(makeStack([alertButton, sheetButton, result]), in: view)
    }

    private func showAlert() {
        let alert = UIAlertController(title: "Remove item?", message: "It goes to the bin.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Remove", style: .destructive) { [weak self] _ in
            self?.result.text = "Result: Removed"
        })
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
            self?.result.text = "Result: Kept"
        })
        present(alert, animated: true)
    }

    private func showSheet(from source: UIView) {
        let sheet = UIAlertController(title: "Export", message: nil, preferredStyle: .actionSheet)
        sheet.addAction(UIAlertAction(title: "Export PDF", style: .default) { [weak self] _ in
            self?.result.text = "Result: PDF"
        })
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
            self?.result.text = "Result: Cancelled"
        })
        sheet.popoverPresentationController?.sourceView = source
        present(sheet, animated: true)
    }
}

// ─── Keyboard ───

final class UIKitKeyboardViewController: UIViewController, UITextFieldDelegate {
    private let entered = makeLabel("Nothing entered")

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let scroll = UIScrollView()
        scroll.keyboardDismissMode = .onDrag
        scroll.alwaysBounceVertical = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        let city = UITextField()
        city.placeholder = "City"
        city.borderStyle = .roundedRect
        city.returnKeyType = .done
        city.autocorrectionType = .no
        city.delegate = self

        let notes = UITextView()
        notes.accessibilityIdentifier = "uikit-notes"
        notes.layer.borderWidth = 1
        notes.layer.borderColor = UIColor.separator.cgColor
        notes.heightAnchor.constraint(equalToConstant: 100).isActive = true

        // Display text, not an input: a UITextView that can't be edited (PILOT-697).
        let terms = UITextView()
        terms.text = "By continuing you accept the terms."
        terms.isEditable = false
        terms.accessibilityIdentifier = "uikit-terms"
        terms.isScrollEnabled = false

        let content = makeStack([terms, city, entered, notes])
        content.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
            content.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 24),
            content.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -24),
            content.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
        ])
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        entered.text = "Entered: \(textField.text ?? "")"
        textField.resignFirstResponder()
        return true
    }
}

// ─── Gestures ───

final class UIKitGesturesViewController: UIViewController {
    private let status = makeLabel("Status: Waiting")

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let doubleTap = makeTarget("Double tap me", color: .systemGreen)
        let doubleRecognizer = UITapGestureRecognizer(target: self, action: #selector(doubleTapped))
        doubleRecognizer.numberOfTapsRequired = 2
        doubleTap.addGestureRecognizer(doubleRecognizer)

        let longPress = makeTarget("Long press me", color: .systemBlue)
        let longRecognizer = UILongPressGestureRecognizer(target: self, action: #selector(longPressed(_:)))
        longRecognizer.minimumPressDuration = 0.8
        longPress.addGestureRecognizer(longRecognizer)

        // PILOT-825: a UIPinchGestureRecognizer, reporting which way it scaled.
        let pinch = makeTarget("Pinch me", color: .systemPurple, height: 200)
        pinch.accessibilityIdentifier = "uikit-pinch-area"
        pinch.addGestureRecognizer(UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:))))

        pin(makeStack([status, doubleTap, longPress, pinch]), in: view)
    }

    private func makeTarget(_ text: String, color: UIColor, height: CGFloat = 56) -> UILabel {
        let label = makeLabel(text)
        label.textAlignment = .center
        label.backgroundColor = color.withAlphaComponent(0.2)
        label.heightAnchor.constraint(equalToConstant: height).isActive = true
        label.isUserInteractionEnabled = true
        label.accessibilityTraits = .button
        return label
    }

    @objc private func doubleTapped() { status.text = "Status: Double tapped" }

    @objc private func pinched(_ recognizer: UIPinchGestureRecognizer) {
        if recognizer.state == .ended {
            status.text = recognizer.scale < 1 ? "Status: Pinched in" : "Status: Pinched out"
        }
    }

    @objc private func longPressed(_ recognizer: UILongPressGestureRecognizer) {
        if recognizer.state == .began { status.text = "Status: Long pressed" }
    }
}
