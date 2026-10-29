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
Item {
  id: root

  // Injected by omarchy-shell; the host reads `opened`, calls open()/close().
  property string omarchyPath: Quickshell.env("OMARCHY_PATH")
  property var shell: null
  property var manifest: null
  property bool opened: false

  readonly property string pluginId: (manifest && manifest.id) || "dev.leonardo.milo_spotlight"

  // ── theme: bound, never cached, so a theme swap repaints the popup ────────
  readonly property color background: Commons.Color.menu.background
  readonly property color foreground: Commons.Color.menu.text
  readonly property color accent: Commons.Color.accent
  readonly property color urgent: Commons.Color.urgent
  readonly property color scrim: Commons.Color.menu.scrim
  readonly property var borderSpec: Border.surfaceSpec("menu", "border", Commons.Color.menu.border, Math.max(1, Style.space(2)))
  readonly property string fontFamily: Style.font.menuFamily
  readonly property int cornerRadius: Style.cornerRadius
  readonly property int pad: Style.spacing.panelPadding
  readonly property int gap: Style.spacing.md
  readonly property int cardWidth: Math.min(Style.space(680), panel.width - Style.gapsOut * 2)
  readonly property int cardHeight: Math.min(Style.space(520), panel.height - Style.gapsOut * 2)
  readonly property int answerHeight: Math.min(Style.space(320), panel.height - Style.gapsOut * 2 - Style.space(200))

  // ── what the panel is showing ────────────────────────────────────────────
  property string query: ""
  property string question: ""
  property string answer: ""
  property string step: ""
  property string status: "Ready"
  property bool busy: false
  property bool connected: false
  property string permissionId: ""
  property string permissionTool: ""
  property string permissionSummary: ""
  property int restartDelay: 1000

  readonly property bool awaitingPermission: permissionId !== ""
  readonly property string line: step !== "" ? step : status

  // ── the host's contract ──────────────────────────────────────────────────
  function open(payloadJson) {
    opened = true
    query = ""
    question = ""
    answer = ""
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

  /** Dismissed by the person: Escape, a click outside, or the thread handed over. */
  function dismiss() {
    stop()
    opened = false
    if (shell && typeof shell.hide === "function") shell.hide(pluginId)
  }

  function toggle() {
    if (opened) dismiss()
    else open("{}")
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
      answer += message.delta
    } else if (message.type === "tool") {
      step = message.text
    } else if (message.type === "permission") {
      permissionId = String(message.id)
      permissionTool = String(message.tool)
      permissionSummary = String(message.summary)
      status = "Waiting for you"
      busy = true
      Qt.callLater(function() { allowButton.forceActiveFocus() })
    } else if (message.type === "permission-result") {
      if (String(message.id) === permissionId) clearPermission()
    } else if (message.type === "end") {
      busy = false
      step = ""
      status = message.says ? String(message.says) : (message.status === "done" ? "Done" : message.status === "stopped" ? "Stopped" : "Something went wrong")
      Qt.callLater(function() { prompt.forceActiveFocus() })
    } else if (message.type === "error") {
      status = String(message.message)
      busy = false
    } else if (message.type === "fork") {
      if (message.url) Quickshell.execDetached(["xdg-open", String(message.url)])
      dismiss()
    }
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

  // ── the two keys ─────────────────────────────────────────────────────────
  function handleKey(event) {
    if (event.key === Qt.Key_Escape) {
      dismiss()
      event.accepted = true
    } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
      if (event.modifiers & Qt.ControlModifier) handOver()
      else ask()
      event.accepted = true
    }
  }

  function ask() {
    const text = query.trim()
    if (text === "" || busy) return
    question = text
    answer = ""
    step = ""
    status = "Thinking…"
    busy = true
    query = ""
    send({ type: "ask", text: text })
    Qt.callLater(function() { prompt.forceActiveFocus() })
  }

  /** The question outgrew the popup: the bridge forks it and hands over its address. */
  function handOver() {
    if (question === "" || busy) return
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
    WlrLayershell.namespace: "omarchy-milo-spotlight"

    Rectangle {
      anchors.fill: parent
      color: root.scrim
    }

    MouseArea {
      anchors.fill: parent
      onClicked: root.dismiss()
    }

    BorderSurface {
      id: card
      anchors.centerIn: parent
      width: root.cardWidth
      height: Math.min(root.cardHeight, content.implicitHeight + card.contentTopInset + card.contentBottomInset)
      radius: root.cornerRadius
      color: root.background
      borderSpec: root.borderSpec
      padding: root.pad

      MouseArea { anchors.fill: parent; onClicked: {} }

      Item {
        anchors.fill: parent
        // Keys the field does not take — Escape while a button has focus — still
        // reach the popup on their way up.
        Keys.onPressed: function(event) { root.handleKey(event) }

        ColumnLayout {
          id: content
          anchors.fill: parent
          anchors.topMargin: card.contentTopInset
          anchors.rightMargin: card.contentRightInset
          anchors.bottomMargin: card.contentBottomInset
          anchors.leftMargin: card.contentLeftInset
          spacing: root.gap

          RowLayout {
            Layout.fillWidth: true
            spacing: Style.spacing.controlGap

            Text {
              textFormat: Text.PlainText
              text: "󰚩"
              color: root.accent
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
              font.pixelSize: Style.font.title
              placeholderText: "Ask Milo anything…"
              horizontalPadding: Style.spacing.controlPaddingX
              verticalPadding: Style.spacing.controlPaddingY
              Keys.priority: Keys.BeforeItem
              Keys.onPressed: function(event) { root.handleKey(event) }
            }

            Button {
              visible: root.busy
              text: "Stop"
              foreground: root.foreground
              accent: root.accent
              fontFamily: root.fontFamily
              onClicked: {
                root.stop()
                Qt.callLater(function() { prompt.forceActiveFocus() })
              }
            }
          }

          Text {
            textFormat: Text.PlainText
            visible: root.question !== ""
            Layout.fillWidth: true
            text: root.question
            color: root.foreground
            opacity: 0.62
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            elide: Text.ElideRight
          }

          PanelSeparator { visible: root.question !== ""; foreground: root.foreground }

          ScrollView {
            id: output
            Layout.fillWidth: true
            Layout.preferredHeight: root.answerHeight
            visible: root.answer !== ""
            clip: true
            ScrollBar.horizontal.policy: ScrollBar.AlwaysOff

            Text {
              id: answerText
              width: output.availableWidth
              text: root.answer
              textFormat: Text.PlainText
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              lineHeight: 1.35
              wrapMode: Text.Wrap
              onContentHeightChanged: {
                const bar = output.ScrollBar.vertical
                if (bar) bar.position = Math.max(0, 1 - bar.size)
              }
            }
          }

          // An approval is the one thing the popup cannot skip: a turn waiting on
          // one goes nowhere until the person says yes or no.
          ColumnLayout {
            Layout.fillWidth: true
            spacing: Style.spacing.sm
            visible: root.awaitingPermission

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

          Text {
            textFormat: Text.PlainText
            Layout.fillWidth: true
            text: root.line
            color: root.busy ? root.accent : root.foreground
            opacity: 0.7
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }

          Text {
            textFormat: Text.PlainText
            Layout.fillWidth: true
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
}
