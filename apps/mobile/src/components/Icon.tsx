import Svg, { Circle, Path, Rect } from 'react-native-svg'

/** The line icons of the design (24 by 24, stroked), shared with the web client. */
const ICONS = {
  clock: (
    <>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M12 7v5l3 2" />
    </>
  ),
  send: <Path d="M4 12l16-8-6 16-3-7z" />,
  chevronDown: <Path d="M6 9l6 6 6-6" />,
  close: <Path d="M6 6l12 12M18 6L6 18" />,
  file: (
    <>
      <Path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
      <Path d="M14 3v5h5" />
    </>
  ),
  bold: (
    <>
      <Path d="M7 4h6a4 4 0 010 8H7z" />
      <Path d="M7 12h7a4 4 0 010 8H7z" />
    </>
  ),
  italic: <Path d="M10 4h8M6 20h8M14 4l-4 16" />,
  list: (
    <>
      <Path d="M9 6h11M9 12h11M9 18h11" />
      <Path d="M4 6h.01M4 12h.01M4 18h.01" />
    </>
  ),
  link: (
    <>
      <Path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1" />
      <Path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />
    </>
  ),
  attach: <Path d="M20 11l-8.5 8.5a5 5 0 01-7-7L13 4a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L14 7" />,
  photo: (
    <>
      <Rect x="3" y="4" width="18" height="16" rx="2" />
      <Circle cx="9" cy="10" r="2" />
      <Path d="M21 16l-5-5-9 9" />
    </>
  ),
  pen: <Path d="M4 20h4L19 9l-4-4L4 16z" />,
  back: <Path d="M15 6l-6 6 6 6" />,
  todo: (
    <>
      <Path d="M9 11l3 3 8-8" />
      <Path d="M20 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
    </>
  ),
  video: (
    <>
      <Rect x="3" y="6" width="13" height="12" rx="2" />
      <Path d="M16 10l5-3v10l-5-3" />
    </>
  ),
  copy: (
    <>
      <Rect x="9" y="9" width="11" height="11" rx="2" />
      <Path d="M5 15V6a1 1 0 011-1h9" />
    </>
  ),
  check: <Path d="M5 12l5 5L20 7" />,
} as const

export type IconName = keyof typeof ICONS

/** A decorative icon: the control around it carries the accessible label. */
export function Icon({ name, size = 20, color, strokeWidth = 2 }: { name: IconName; size?: number; color: string; strokeWidth?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" accessible={false} importantForAccessibility="no-hide-descendants">
      {ICONS[name]}
    </Svg>
  )
}
