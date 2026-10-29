import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Commons as Commons
import qs.Ui

// Milo's desktop popup: the one question, the answer as it arrives, and the two
// keys that matter. It draws with Omarchy's own kit, so it follows the theme and
// the motion of the shell instead of carrying a look of its own.
//
// The answer is not drawn here: `milo spotlight` is a child process speaking
// NDJSON over stdio — the shell's own shape for a long-lived helper — and it
// serves this panel the same turns the browser and the phone get, permissions
// included. Anything richer than text is one key away in the full app.
//
// It lives in the bottom-right corner: close enough to the work to be read,
// far enough to leave the machine usable. Summoned, it takes the keyboard only
// long enough for the question; asked, it holds none at all — keys go to
// whatever window is in front, and the popup only takes them back when clicked.
Item {
  id: root

  // Injected by omarchy-shell; the host reads `opened`, calls open()/close().
  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property var shell: null
  property var manifest: null
  property bool opened: false
  /** Asked: the popup has stepped aside and the desktop is usable again. */
  property bool working: false

  readonly property string pluginId: (manifest && manifest.id) || "dev.leonardo.milo_spotlight"

  // ── theme: bound, never cached, so a theme swap repaints the popup ────────
  readonly property color foreground: Commons.Color.menu.text
  readonly property color background: Commons.Color.popups.background
  readonly property color accent: Commons.Color.accent
  readonly property color urgent: Commons.Color.urgent
  // Milo's own orange, not the desktop theme's accent: the popup is Milo in
  // Omarchy's clothes, and the person's words wear Milo's colour. The same value
  // as `src/gateways/cli/theme.ts` and the web's `--accent`.
  readonly property color miloAccent: "#C4541C"
  readonly property color miloAccentOn: "#FFFFFF"
  readonly property var borderSpec: Border.surfaceSpec("popups", "border", Commons.Color.popups.border, Math.max(1, Style.space(2)))
  readonly property var accentBorderSpec: Border.surfaceSpec("popups", "border", "#A64514", Math.max(1, Style.space(2)))
  readonly property string fontFamily: Style.font.menuFamily
  readonly property int cornerRadius: Style.cornerRadius
  readonly property int pad: Style.spacing.controlPaddingX
  readonly property int gap: Style.spacing.sm
  readonly property int margin: Style.space(16)
  readonly property int stackWidth: Math.min(Style.space(420), panel.width - root.margin * 2)
  readonly property int maxHeight: panel.height - root.margin * 2

  // ── what the panel is showing ────────────────────────────────────────────
  property string query: ""
  property string step: ""
  property string status: "Ready"
  property bool busy: false
  property bool connected: false
  property int miloAt: -1
  property string permissionId: ""
  property string permissionTool: ""
  property string permissionSummary: ""
  property int restartDelay: 1000

  readonly property bool awaitingPermission: permissionId !== ""
  readonly property string line: step !== "" ? step : status

  /** The conversation, one bubble each: `you`, `milo`, `step`. */
  ListModel { id: thread }

  // ── the host's contract ──────────────────────────────────────────────────
  function open(payloadJson) {
    opened = true
    working = false
    thread.clear()
    miloAt = -1
    query = ""
    prompt.text = ""
    step = ""
    status = "Ready"
    busy = false
    clearPermission()
    send({ type: "new" })
    Qt.callLater(function() { prompt.forceActiveFocus() })
  }

  /** Called by the shell when it hides the overlay for any reason. */
  function close() {
    stop()
    opened = false
  }

  /** Dismissed by the person: Escape, a click outside, the close button, or a hand-over. */
  function dismiss() {
    stop()
    opened = false
    working = false
    if (shell && typeof shell.hide === "function") shell.hide(pluginId)
  }

  function toggle() {
    // The hotkey opens and closes. While the popup holds no keyboard — the answer
    // is on its way — Escape belongs to whatever window is in front, so this is
    // the way to put it away from the keyboard, and the close button for a pointer.
    if (opened) dismiss()
    else open("{}")
  }

  /** Back to typing, in the conversation that is already open. */
  function focusInput() {
    working = false
    prompt.forceActiveFocus()
    Qt.callLater(function() { prompt.forceActiveFocus() })
  }

  function stop() {
    if (!busy) return
    busy = false
    send({ type: "stop" })
  }

  // ── talking to the bridge ────────────────────────────────────────────────
  function send(command) {
    if (!bridge.running) return
    bridge.write(JSON.stringify(command) + "\n")
  }

  function handleLine(text) {
    var message
    try {
      message = JSON.parse(text)
    } catch (error) {
      return
    }
    restartDelay = 1000
    if (message.type === "status") {
      status = message.text
    } else if (message.type === "ready") {
      connected = true
      if (status === "Starting Milo…" || status === "") status = "Ready"
    } else if (message.type === "text") {
      appendToAnswer(String(message.delta))
    } else if (message.type === "tool") {
      step = message.text
    } else if (message.type === "permission") {
      permissionId = String(message.id)
      permissionTool = String(message.tool)
      permissionSummary = String(message.summary)
      status = "Waiting for you"
      busy = true
      working = true
      Qt.callLater(function() { allowButton.forceActiveFocus() })
    } else if (message.type === "permission-result") {
      if (String(message.id) === permissionId) clearPermission()
    } else if (message.type === "end") {
      busy = false
      step = ""
      status = message.says ? String(message.says) : (message.status === "done" ? "Done" : message.status === "stopped" ? "Stopped" : "Something went wrong")
    } else if (message.type === "error") {
      status = String(message.message)
      busy = false
    } else if (message.type === "fork") {
      if (message.url) Quickshell.execDetached(["xdg-open", String(message.url)])
      dismiss()
    }
  }

  function appendToAnswer(delta) {
    if (miloAt >= 0 && miloAt < thread.count) {
      thread.setProperty(miloAt, "text", String(thread.get(miloAt).text) + delta)
      return
    }
    thread.append({ role: "milo", text: delta })
    miloAt = thread.count - 1
  }

  function clearPermission() {
    permissionId = ""
    permissionTool = ""
    permissionSummary = ""
  }

  function answerPermission(decision) {
    if (permissionId === "") return
    send({ type: "permission", id: permissionId, decision: decision })
    clearPermission()
    Qt.callLater(function() { prompt.forceActiveFocus() })
  }

  function ask() {
    const text = query.trim()
    if (text === "" || busy) return
    thread.append({ role: "you", text: text })
    thread.append({ role: "milo", text: "" })
    miloAt = thread.count - 1
    query = ""
    prompt.text = ""
    step = ""
    status = "Thinking…"
    busy = true
    // Asked: the popup steps out of the way so the machine can be used while the
    // answer arrives. The keyboard is given back to whatever is in front.
    working = true
    prompt.focus = false
    send({ type: "ask", text: text })
  }

  /** The question outgrew the popup: the bridge forks it and hands over its address. */
  function handOver() {
    if (thread.count === 0 || busy) return
    status = "Opening in Milo…"
    send({ type: "continue" })
  }

  // ── the answer process ───────────────────────────────────────────────────
  Process {
    id: bridge
    running: true
    stdinEnabled: true
    command: ["milo", "spotlight"]
    onRunningChanged: {
      if (running) return
      root.connected = false
      if (root.status.indexOf("milo") === -1) root.status = "Milo is not running"
      restartTimer.restart()
    }
    stdout: SplitParser {
      onRead: function(line) { root.handleLine(line) }
    }
    stderr: SplitParser {
      onRead: function(line) {
        if (line.trim() !== "") console.warn("milo spotlight:", line.trim())
      }
    }
  }

  Timer {
    id: restartTimer
    interval: root.restartDelay
    onTriggered: {
      root.restartDelay = Math.min(30000, root.restartDelay * 2)
      bridge.running = true
    }
  }

  ShellIpc {
    target: root.pluginId
    function toggle(): void { root.toggle() }
    function open(): void { root.open("{}") }
    function close(): void { root.dismiss() }
  }

  // ── the surface ──────────────────────────────────────────────────────────
  OverlayWindow {
    id: panel
    shown: root.opened
    // Exclusive only while the question is being typed: a layer surface that asks
    // for focus keeps the whole desktop from receiving keys. Asked, it holds
    // `None`, so the person can type into whatever is behind this — the popup
    // takes the keyboard back only when it is clicked.
    shownKeyboardFocus: root.working ? WlrKeyboardFocus.None : WlrKeyboardFocus.Exclusive
    WlrLayershell.namespace: "omarchy-milo-spotlight"

    // The rest of the screen is not ours: only the bubbles and the field take a
    // click, so the desktop behind stays usable the whole time.
    mask: Region {
      item: stack
    }

    Item {
      id: stack
      width: root.stackWidth
      height: Math.min(root.maxHeight, column.implicitHeight)
      x: parent.width - width - root.margin
      y: parent.height - height - root.margin

      // A click on the bubbles brings the field back, for a follow-up.
      MouseArea {
        anchors.fill: parent
        onClicked: root.focusInput()
      }

      Column {
        id: column
        width: parent.width
        spacing: root.gap

        Repeater {
          model: thread

          delegate: Item {
            id: bubbleRow
            required property int index
            required property string role
            required property string text

            width: column.width
            // An answer that has not said anything yet has no bubble: the status
            // line below is what says the turn is on its way.
            height: bubbleRow.text === "" ? 0 : bubble.height

            BorderSurface {
              id: bubble
              visible: bubbleRow.text !== ""
              x: bubbleRow.role === "you" ? bubbleRow.width - width : 0
              width: Math.min(
                bubbleRow.width * (bubbleRow.role === "you" ? 0.86 : 0.94),
                label.implicitWidth + root.pad * 2)
              height: label.implicitHeight + root.pad * 2
              radius: root.cornerRadius
              borderSpec: bubbleRow.role === "you" ? root.accentBorderSpec : root.borderSpec
              // The person's own words wear Milo's orange; the answer wears the
              // kit's plain popup surface. Two fills, so the two speakers read
              // apart at a glance.
              color: bubbleRow.role === "you" ? root.miloAccent : root.background

              Text {
                id: label
                anchors.fill: parent
                anchors.margins: root.pad
                text: bubbleRow.text
                textFormat: Text.PlainText
                color: bubbleRow.role === "you" ? root.miloAccentOn : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                lineHeight: 1.3
                wrapMode: Text.Wrap
              }
            }
          }
        }

        // An approval is the one thing the popup cannot skip: a turn waiting on
        // one goes nowhere until the person says yes or no.
        BorderSurface {
          width: parent.width
          height: permissionColumn.implicitHeight + root.pad * 2
          radius: root.cornerRadius
          color: root.background
          borderSpec: root.borderSpec
          visible: root.awaitingPermission

          ColumnLayout {
            id: permissionColumn
            anchors.fill: parent
            anchors.margins: root.pad
            spacing: Style.spacing.sm

            Text {
              textFormat: Text.PlainText
              Layout.fillWidth: true
              text: "Milo wants to run " + root.permissionTool
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }

            Text {
              textFormat: Text.PlainText
              Layout.fillWidth: true
              text: root.permissionSummary
              color: root.foreground
              opacity: 0.75
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.Wrap
            }

            RowLayout {
              spacing: Style.spacing.controlGap

              Button {
                id: allowButton
                text: "Allow"
                foreground: root.foreground
                accent: root.accent
                onClicked: root.answerPermission("allow")
              }

              Button {
                text: "Always"
                tooltipText: "Allow this for the rest of the conversation"
                foreground: root.foreground
                accent: root.accent
                onClicked: root.answerPermission("always")
              }

              Button {
                text: "Deny"
                foreground: root.urgent
                accent: root.urgent
                onClicked: root.answerPermission("deny")
              }
            }
          }
        }

        // The question line, in a surface of its own so it reads as one control
        // among the messages rather than as part of them.
        BorderSurface {
          width: parent.width
          height: promptRow.implicitHeight + Style.spacing.controlPaddingY * 2
          radius: root.cornerRadius
          color: root.background
          borderSpec: root.borderSpec

          RowLayout {
            id: promptRow
            anchors.fill: parent
            anchors.leftMargin: Style.spacing.controlPaddingX
            anchors.rightMargin: Style.spacing.controlPaddingX
            anchors.topMargin: Style.spacing.controlPaddingY
            anchors.bottomMargin: Style.spacing.controlPaddingY
            spacing: Style.spacing.controlGap

            Text {
              textFormat: Text.PlainText
              text: "󰚩"
              color: root.miloAccent
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              Layout.alignment: Qt.AlignVCenter
            }

            TextField {
              id: prompt
              Layout.fillWidth: true
              foreground: root.foreground
              accent: root.accent
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              placeholderText: "Ask Milo anything…"
              horizontalPadding: 0
              verticalPadding: Style.spacing.controlPaddingY / 2
              background: null
              // The field owns the two keys: a layer-shell surface is not an active
              // Qt window, so a window-level shortcut never fires there.
              onTextChanged: root.query = text
              // A TextField consumes Return itself, so the popup listens to its own
              // `accepted` rather than to the key: the latter never sees it.
              onAccepted: root.ask()
              Keys.priority: Keys.BeforeItem
              Keys.onPressed: function(event) {
                if (event.key === Qt.Key_Escape) {
                  root.dismiss()
                  event.accepted = true
                } else if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter)
                  && (event.modifiers & (Qt.ControlModifier | Qt.MetaModifier))) {
                  root.handOver()
                  event.accepted = true
                }
              }
            }

            Button {
              visible: root.busy
              text: "Stop"
              foreground: root.foreground
              accent: root.accent
              onClicked: {
                root.stop()
                Qt.callLater(function() { prompt.forceActiveFocus() })
              }
            }

            Button {
              iconText: "󰅖"
              tooltipText: "Close"
              foreground: root.foreground
              accent: root.accent
              onClicked: root.dismiss()
            }
          }
        }

        Text {
          textFormat: Text.PlainText
          width: parent.width
          text: root.line
          color: root.busy ? root.accent : root.foreground
          opacity: 0.7
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }

        Text {
          textFormat: Text.PlainText
          width: parent.width
          // Only while it is true: at work the popup holds no keyboard, and Escape
          // there belongs to the window in front.
          visible: !root.working
          text: "Esc closes · Ctrl + Enter continues in Milo"
          color: root.foreground
          opacity: 0.45
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }
  }
}
