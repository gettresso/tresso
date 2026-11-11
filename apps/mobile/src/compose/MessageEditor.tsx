import { forwardRef, useImperativeHandle, useMemo, useRef, useState, type ComponentRef } from 'react'
import { StyleSheet } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { mayLoad } from '@/components/frameLinks'
import { editorDocument } from '@/compose/editorDocument'
import { editorScript, parseEditorEvent, type EditorCommand, type EditorEvent } from '@/compose/editorProtocol'
import { useTheme } from '@/theme'

export type EditorState = Extract<EditorEvent, { type: 'state' }>

export interface MessageEditorHandle {
  run(command: EditorCommand): void
}

interface Props {
  /** The text when the editor opens; later changes come from the user only. */
  initialHtml: string
  onChange(html: string): void
  onState(state: EditorState): void
  onFocus?(focused: boolean): void
}

const MIN_HEIGHT = 120
/** Taller text scrolls with the screen; the editor itself never scrolls. */
const MAX_HEIGHT = 20000

/** The message text: tiptap in a web view, writing the same HTML as the web client. */
export const MessageEditor = forwardRef<MessageEditorHandle, Props>(function MessageEditor({ initialHtml, onChange, onState, onFocus }, ref) {
  const theme = useTheme()
  const view = useRef<ComponentRef<typeof WebView>>(null)
  const ready = useRef(false)
  /** Commands asked for before the editor was ready, run once it is. */
  const waiting = useRef<EditorCommand[]>([])
  const [height, setHeight] = useState(MIN_HEIGHT)
  const initial = useRef(initialHtml)
  // Built once per theme: a new document would reload the editor and lose what is being typed.
  const html = useMemo(() => editorDocument(theme, { label: 'Message', placeholder: 'Message' }), [theme])

  function send(command: EditorCommand): void {
    if (!ready.current) {
      waiting.current.push(command)
      return
    }
    view.current?.injectJavaScript(editorScript(command))
  }

  useImperativeHandle(ref, () => ({ run: send }))

  function receive(event: WebViewMessageEvent): void {
    const message = parseEditorEvent(event.nativeEvent.data)
    if (message === null) {
      return
    }
    switch (message.type) {
      case 'ready':
        ready.current = true
        view.current?.injectJavaScript(editorScript({ type: 'set', html: initial.current }))
        for (const command of waiting.current.splice(0)) {
          view.current?.injectJavaScript(editorScript(command))
        }
        return
      case 'change':
        initial.current = message.html
        onChange(message.html)
        return
      case 'state':
        onState(message)
        return
      case 'focus':
        onFocus?.(message.focused)
        return
      case 'height':
        setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, message.value)))
        return
      case 'error':
        console.error('The message editor failed', message.message)
        return
    }
  }

  return (
    <WebView
      ref={view}
      style={[styles.editor, { height, backgroundColor: theme.surface }]}
      originWhitelist={['*']}
      source={{ html, baseUrl: '' }}
      onLoadStart={() => {
        // A reload (after the theme changed) starts the editor over: it gets the current text again once ready.
        ready.current = false
      }}
      onMessage={receive}
      // Nothing leaves the editor: links in the text are not followed while writing (see frameLinks).
      onShouldStartLoadWithRequest={(request) => mayLoad(request.url)}
      scrollEnabled={false}
      javaScriptEnabled
      allowFileAccess={false}
      mixedContentMode="never"
      hideKeyboardAccessoryView
      keyboardDisplayRequiresUserAction={false}
      setSupportMultipleWindows={false}
      allowsLinkPreview={false}
      accessibilityLabel="Message"
    />
  )
})

const styles = StyleSheet.create({
  editor: { width: '100%' },
})
