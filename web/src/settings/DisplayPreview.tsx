import { MessageList } from '../chat/MessageList.js'
import { toolText } from '../../../src/gateways/tool-line.ts'
import { previewTurn, type PreviewTools } from './preview-turn.js'

/**
 * A sample turn drawn by the chat's own renderer, so what shows here is what the
 * chat will show. Only the two settings that change the transcript are in play:
 * how much of a tool call is drawn, and whether thinking is shown.
 */
export function DisplayPreview({ tools, thinking }: { tools: PreviewTools; thinking: 'on' | 'off' }) {
  return <>
    <h3 className="section-label">Preview</h3>
    <div className="settings-preview">
      <MessageList messages={previewTurn(tools, toolText)} thinking={thinking === 'on'} />
    </div>
  </>
}
