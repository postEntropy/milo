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
  // Paired with `popups.background`, the surface every part of the popup is drawn on.
  readonly property color foreground: Commons.Color.popups.text
  readonly property color background: Commons.Color.popups.background
  readonly property color accent: Commons.Color.accent
  readonly property color urgent: Commons.Color.urgent
  // Every colour here is the theme's: the popup is a guest on the desktop, and a
  // theme swap is meant to repaint all of it. The person's words are the one filled
  // surface, and it is the accent mixed half into the popup surface — opaque,
  // because the popup floats on the desktop — so the words keep the foreground's
  // contrast instead of sitting on a slab dark enough to swallow them.
  readonly property color youFill: Qt.rgba(
    background.r + (accent.r - background.r) * 0.5,
    background.g + (accent.g - background.g) * 0.5,
    background.b + (accent.b - background.b) * 0.5,
    1)
  readonly property var borderSpec: Border.surfaceSpec("popups", "border", Commons.Color.popups.border, Math.max(1, Style.space(2)))
  readonly property string fontFamily: Style.font.menuFamily
  readonly property int cornerRadius: Style.cornerRadius
  readonly property int pad: Style.spacing.controlPaddingX
  readonly property int gap: Style.spacing.sm
  readonly property int margin: Style.space(16)
  readonly property int stackWidth: Math.min(Style.space(420), panel.width - root.margin * 2)
  readonly property int maxHeight: panel.height - root.margin * 2

  // ── what the panel is showing ────────────────────────────────────────────
  property string query: ""
  property string pendingQuery: ""
  property bool sending: false
  property bool permissionSending: false
  property string projectName: ""
  property string chatId: ""
  property var projects: []
  property bool projectsRequested: false
  property int selectedProject: -1
  readonly property var matchingProjects: query.startsWith("@") && !query.includes("\n")
    ? projects.filter(function(project) { return project.name.toLowerCase().includes(query.slice(1).toLowerCase()) || project.id.toLowerCase().includes(query.slice(1).toLowerCase()) }).slice(0, 5)
    : []
  property string step: ""
  property string status: "Ready"
  property string errorText: ""
  property bool busy: false
  property bool connected: false
  /** No daemon is there: the popup says so and keeps a question in its field rather than losing it. */
  property bool offline: false
  property int miloAt: -1
  property string permissionId: ""
  property string permissionTool: ""
  property string permissionSummary: ""
  property int restartDelay: 1000
  /** The last thing the helper said on stderr — the reason it stopped, never guessed at. */
  property string helperError: ""

  readonly property string offlineText: "Milo is not running. Start it with milo serve."

  readonly property bool awaitingPermission: permissionId !== ""
  readonly property string line: errorText !== "" ? errorText : step !== "" ? step : status

  /** What the line says when no turn is in flight: the daemon's state, or the helper's own failure. */
  function idleStatus() {
    if (offline) return offlineText
    if (!bridge.running) return helperError !== "" ? "Milo's popup helper failed: " + helperError : "Milo's popup helper stopped. Retrying…"
    return "Ready"
  }

  /** The visible session, including progress and failed tools. */
  ListModel { id: thread }

  // ── the host's contract ──────────────────────────────────────────────────
  function open(payloadJson) {
    opened = true
    working = false
    Qt.callLater(function() { if (root.awaitingPermission) allowButton.forceActiveFocus(); else prompt.forceActiveFocus() })
  }

  /** Called by the shell when it hides the overlay for any reason. */
  function close() {
    opened = false
  }

  /** Dismissed by the person: Escape, a click outside, the close button, or a hand-over. */
  function dismiss() {
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

  /** Back to typing in the session that is already open. */
  function focusInput() {
    working = false
    prompt.forceActiveFocus()
    Qt.callLater(function() { prompt.forceActiveFocus() })
  }

  function stop() {
    if (!busy) return
    status = "Stopping…"
    step = ""
    send({ type: "stop" })
  }

  function newSession() {
    if (busy || sending) return
    thread.clear()
    miloAt = -1
    projectName = ""
    chatId = ""
    clearPermission()
    send({ type: "new" })
    errorText = ""
    status = "Connecting…"
    focusInput()
  }

  function appendHistory(messages) {
    for (var i = 0; i < messages.length; i++) {
      if (messages[i].text !== "") thread.append({ role: messages[i].role === "user" ? "you" : messages[i].role === "assistant" ? "milo" : messages[i].role, text: messages[i].text })
    }
    miloAt = -1
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
      if (message.text === "Reconnecting…") { connected = false; permissionSending = false }
    } else if (message.type === "offline") {
      offline = true
      connected = false
      step = ""
      status = offlineText
    } else if (message.type === "ready") {
      connected = true
      offline = false
      helperError = ""
      chatId = message.chatId || ""
      projectName = message.project || ""
      thread.clear()
      appendHistory(message.messages || [])
      busy = message.busy
      clearPermission()
      // The turn in flight keeps its own line; a reconnection that interrupts nothing says where things stand.
      if (!busy) status = idleStatus()
    } else if (message.type === "history") {
      appendHistory(message.messages || [])
    } else if (message.type === "turn-start") {
      if (thread.count === 0 || thread.get(thread.count - 1).role !== "you" || thread.get(thread.count - 1).text !== message.text)
        thread.append({ role: "you", text: message.text })
      thread.append({ role: "milo", text: "" })
      miloAt = thread.count - 1
      busy = true
      status = "Thinking…"
    } else if (message.type === "state") {
      busy = message.busy
    } else if (message.type === "accepted") {
      if (query === pendingQuery) prompt.text = ""
      pendingQuery = ""
      sending = false
      status = "Thinking…"
      working = true
      prompt.focus = false
    } else if (message.type === "projects") {
      projects = message.projects
    } else if (message.type === "text") {
      appendToAnswer(String(message.delta))
    } else if (message.type === "notice") {
      thread.append({ role: "milo", text: String(message.text) })
      miloAt = -1
    } else if (message.type === "tool") {
      if (message.state === "running") {
        if (miloAt >= 0 && thread.get(miloAt).text !== "") thread.setProperty(miloAt, "role", "progress")
        miloAt = -1
      }
      if (message.state === "failed") {
        thread.append({ role: "tool", text: message.text + " failed" })
        miloAt = -1
      }
      step = message.text
    } else if (message.type === "permission") {
      permissionId = String(message.id)
      permissionTool = String(message.tool)
      permissionSummary = String(message.summary)
      status = "Waiting for you"
      step = ""
      busy = true
      working = false
      permissionSending = false
      Qt.callLater(function() { allowButton.forceActiveFocus() })
    } else if (message.type === "permission-result") {
      if (String(message.id) === permissionId) clearPermission()
    } else if (message.type === "end") {
      busy = false
      clearPermission()
      step = ""
      status = message.says ? String(message.says) : (message.status === "done" ? "Done" : message.status === "stopped" ? "Stopped" : "Something went wrong")
    } else if (message.type === "error") {
      errorText = String(message.message)
      step = ""
      sending = false
      permissionSending = false
    } else if (message.type === "open") {
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
    permissionSending = false
  }

  function answerPermission(decision) {
    if (permissionId === "" || permissionSending) return
    permissionSending = true
    send({ type: "permission", id: permissionId, decision: decision })
  }

  function ask() {
    const text = query.trim()
    // Nothing to send a question to: keep it in the field, and let the line say why.
    if (text === "" || busy || sending || offline || !connected || !bridge.running) return
    pendingQuery = query
    sending = true
    errorText = ""
    step = ""
    status = "Sending…"
    send({ type: "ask", text: text })
  }

  /** Open this session in the full app. */
  function handOver() {
    if (!connected) return
    status = "Opening in Milo…"
    send({ type: "continue" })
  }

  function selectProject(project) {
    prompt.text = "@" + project.id + " "
    prompt.cursorPosition = prompt.length
    selectedProject = -1
    focusInput()
  }

  // ── the answer process ───────────────────────────────────────────────────
  Process {
    id: bridge
    running: true
    stdinEnabled: true
    command: ["milo", "spotlight"]
    onRunningChanged: {
      if (running) {
        root.helperError = ""
        if (root.chatId !== "") root.send({ type: "resume", chatId: root.chatId })
        return
      }
      // The helper is the popup's own, not the daemon: its death says nothing about
      // whether Milo is up, so the line reports what happened and restarts quietly.
      root.connected = false
      if (root.sending) root.errorText = "The helper stopped before the message was confirmed. Check the session before sending again."
      root.sending = false
      root.permissionSending = false
      root.step = ""
      root.status = root.idleStatus()
      restartTimer.restart()
    }
    stdout: SplitParser {
      onRead: function(line) { root.handleLine(line) }
    }
    stderr: SplitParser {
      onRead: function(line) {
        var said = line.trim()
        if (said === "") return
        console.warn("milo spotlight:", said)
        // The first line is the reason; the rest is its tail.
        if (root.helperError === "") root.helperError = said
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
        y: Math.min(0, stack.height - implicitHeight)
        spacing: root.gap

        Flickable {
          id: messagesView
          width: parent.width
          height: Math.min(messagesColumn.implicitHeight, Math.max(0, root.maxHeight - promptSurface.height - footerSurface.height - (permissionSurface.visible ? permissionSurface.height + root.gap : 0) - (projectSuggestions.visible ? projectSuggestions.implicitHeight + root.gap : 0) - root.gap * 3))
          contentWidth: width
          contentHeight: messagesColumn.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          visible: thread.count > 0
          property bool followEnd: true
          onMovementStarted: followEnd = false
          onMovementEnded: followEnd = atYEnd
          onContentHeightChanged: {
            if (followEnd) Qt.callLater(function() { messagesView.contentY = Math.max(0, messagesView.contentHeight - messagesView.height) })
          }

          ScrollBar.vertical: ScrollBar {
            policy: ScrollBar.AsNeeded
            onPressedChanged: messagesView.followEnd = pressed ? false : messagesView.atYEnd
          }

          Column {
            id: messagesColumn
            width: messagesView.width
            spacing: root.gap

        Repeater {
          model: thread

          delegate: Item {
            id: bubbleRow
            required property int index
            required property string role
            required property string text

            width: messagesColumn.width
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
              borderSpec: root.borderSpec
              // The person's own words wear a tint of the accent; the answer wears
              // the kit's plain popup surface. Two fills, so the two speakers read
              // apart at a glance.
              color: bubbleRow.role === "you" ? root.youFill : root.background

              TextEdit {
                id: label
                anchors.fill: parent
                anchors.margins: root.pad
                text: bubbleRow.text
                // The answer is written in markdown, like every other Milo surface draws
                // it; the person's own words are shown as they typed them.
                textFormat: bubbleRow.role === "you" ? TextEdit.PlainText : TextEdit.MarkdownText
                color: root.foreground
                opacity: bubbleRow.role === "progress" ? 0.7 : 1
                font.family: root.fontFamily
                font.pixelSize: bubbleRow.role === "progress" ? Style.font.bodySmall : Style.font.body
                readOnly: true
                selectByMouse: true
                wrapMode: TextEdit.Wrap
              }
            }
          }
        }
          }
        }

        Button {
          visible: messagesView.visible && !messagesView.atYEnd
          text: "Latest"
          focusable: true
          foreground: root.foreground
          accent: root.accent
          onClicked: {
            messagesView.followEnd = true
            messagesView.contentY = Math.max(0, messagesView.contentHeight - messagesView.height)
          }
        }

        // An approval is the one thing the popup cannot skip: a turn waiting on
        // one goes nowhere until the person says yes or no.
        BorderSurface {
          id: permissionSurface
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
                focusable: true
                enabled: root.connected && !root.permissionSending
                foreground: root.foreground
                accent: root.accent
                onClicked: root.answerPermission("allow")
              }

              Button {
                text: "Always"
                focusable: true
                tooltipText: "Allow this for the rest of the Session"
                enabled: root.connected && !root.permissionSending
                foreground: root.foreground
                accent: root.accent
                onClicked: root.answerPermission("always")
              }

              Button {
                text: "Deny"
                focusable: true
                enabled: root.connected && !root.permissionSending
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
          id: promptSurface
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
              color: root.accent
              font.family: root.fontFamily
              font.pixelSize: Style.font.title
              Layout.alignment: Qt.AlignVCenter
            }

            Flickable {
              id: promptScroll
              Layout.fillWidth: true
              Layout.preferredHeight: Math.min(prompt.contentHeight, Math.max(prompt.font.pixelSize * 2, root.maxHeight - footer.implicitHeight - (permissionSurface.visible ? permissionSurface.height + root.gap : 0) - Style.spacing.controlPaddingY * 3 - root.gap))
              contentWidth: width
              contentHeight: prompt.contentHeight
              clip: true
              boundsBehavior: Flickable.StopAtBounds

              function showCursor() {
                var top = prompt.cursorRectangle.y
                var bottom = top + prompt.cursorRectangle.height
                if (top < contentY) contentY = top
                else if (bottom > contentY + height) contentY = bottom - height
              }

              TextEdit {
                id: prompt
                width: promptScroll.width
                height: contentHeight
                color: root.foreground
                selectionColor: root.accent
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                wrapMode: TextEdit.Wrap
                selectByMouse: true
                onTextChanged: {
                  root.query = text
                  root.selectedProject = -1
                  if (!text.startsWith("@")) root.projectsRequested = false
                  if (text.startsWith("@") && !root.projectsRequested) {
                    root.projectsRequested = true
                    root.send({ type: "projects" })
                  }
                }
                onCursorRectangleChanged: promptScroll.showCursor()
                Keys.priority: Keys.BeforeItem
                Keys.onPressed: function(event) {
                  if (event.key === Qt.Key_Escape) {
                    root.dismiss()
                    event.accepted = true
                  } else if (root.matchingProjects.length > 0 && (event.key === Qt.Key_Down || event.key === Qt.Key_Up)) {
                    root.selectedProject = event.key === Qt.Key_Down
                      ? Math.min(root.matchingProjects.length - 1, root.selectedProject + 1)
                      : Math.max(0, root.selectedProject - 1)
                    event.accepted = true
                  } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                    if (event.modifiers & (Qt.ControlModifier | Qt.MetaModifier)) root.handOver()
                    else if (event.modifiers & Qt.ShiftModifier) return
                    else if (root.selectedProject >= 0 && root.selectedProject < root.matchingProjects.length) root.selectProject(root.matchingProjects[root.selectedProject])
                    else root.ask()
                    event.accepted = true
                  }
                }

                Text {
                  visible: prompt.text === ""
                  text: "Ask Milo anything…"
                  color: root.foreground
                  opacity: 0.5
                  font: prompt.font
                }
              }
            }

            Button {
              iconText: "󰏫"
              tooltipText: "New session"
              focusable: true
              visible: thread.count > 0
              enabled: !root.busy && !root.sending
              foreground: root.foreground
              accent: root.accent
              onClicked: root.newSession()
            }

            Button {
              iconText: "󰏌"
              tooltipText: "Open in Milo"
              focusable: true
              enabled: root.connected
              foreground: root.foreground
              accent: root.accent
              onClicked: root.handOver()
            }

            Button {
              visible: root.busy
              text: "Stop"
              focusable: true
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
              focusable: true
              foreground: root.foreground
              accent: root.accent
              onClicked: root.dismiss()
            }
          }
        }

        Column {
          id: projectSuggestions
          width: parent.width
          spacing: root.gap / 2
          visible: root.matchingProjects.length > 0 && prompt.activeFocus

          Repeater {
            model: root.matchingProjects
            Button {
              required property var modelData
              required property int index
              width: parent.width
              text: modelData.name
              selected: index === root.selectedProject
              tooltipText: "Start a session in " + modelData.name
              foreground: root.foreground
              accent: root.accent
              onClicked: {
                root.selectProject(modelData)
              }
            }
          }
        }

        // The footer sits on the same surface the fields and bubbles do: the popup
        // floats over the desktop, and text laid straight on whatever is behind it
        // is unreadable.
        BorderSurface {
          id: footerSurface
          width: parent.width
          height: footer.implicitHeight + Style.spacing.controlPaddingY
          radius: root.cornerRadius
          color: root.background
          borderSpec: root.borderSpec

          Column {
            id: footer
            anchors.fill: parent
            anchors.leftMargin: Style.spacing.controlPaddingX
            anchors.rightMargin: Style.spacing.controlPaddingX
            anchors.topMargin: Style.spacing.controlPaddingY / 2
            anchors.bottomMargin: Style.spacing.controlPaddingY / 2
            spacing: Style.spacing.sm / 2

            Text {
              textFormat: Text.PlainText
              width: parent.width
              text: root.projectName !== "" ? root.projectName + " · " + root.line : root.line
              color: root.busy ? root.accent : root.foreground
              opacity: 0.85
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }

          }
        }
      }
    }
  }
}
