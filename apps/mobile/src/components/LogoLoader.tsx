import { useEffect, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View, type ColorValue, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { loaderFrames, MOTION, PART_OFFSETS, REDUCED } from '@/components/loaderFrames'
import { useTheme } from '@/theme'

interface Props {
  size?: number
  /** One color for all three parts, for filled buttons where the brand colors would lack contrast. */
  color?: ColorValue
  /** Read out by screen readers; leave it out when the text next to the loader already says what is loading. */
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}

const ease = Easing.bezier(0.65, 0, 0.35, 1)

/** The three parts of the mark on its 24 grid, and the way each one steps out: do left, hand over right, know down. */
const PARTS = [
  { x: 3, y: 4, width: 8.5, height: 5, dx: -1, dy: 0 },
  { x: 12.5, y: 4, width: 8.5, height: 5, dx: 1, dy: 0 },
  { x: 9.5, y: 10.5, width: 5, height: 10, dx: 0, dy: 1 },
] as const

/** How far a part steps out, in grid units. */
const STEP = 1.5

function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    let live = true
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (live) setReduce(enabled)
    })
    // React Native for Web returns no subscription where the browser cannot report the setting (no matchMedia).
    const subscription: { remove(): void } | undefined = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce)
    return () => {
      live = false
      subscription?.remove()
    }
  }, [])
  return reduce
}

/**
 * The Tresso loader, the same motion as the web one: the three parts of the mark step out in turn and settle back.
 * One clock drives all three on the native thread, so they never drift apart.
 */
export function LogoLoader({ size = 24, color, accessibilityLabel, style }: Props) {
  const theme = useTheme()
  const reduce = useReduceMotion()
  const [clock] = useState(() => new Animated.Value(0))
  const motion = reduce ? REDUCED : MOTION

  useEffect(() => {
    clock.setValue(0)
    const loop = Animated.loop(Animated.timing(clock, { toValue: 1, duration: motion.duration, easing: Easing.linear, useNativeDriver: true }))
    loop.start()
    return () => loop.stop()
  }, [clock, motion])

  const unit = size / 24
  const colors = [theme.markDo, theme.markDelegate, theme.markKnow]

  return (
    <View
      style={[{ width: size, height: size }, style]}
      accessible={accessibilityLabel !== undefined}
      accessibilityRole={accessibilityLabel === undefined ? undefined : 'progressbar'}
      accessibilityLabel={accessibilityLabel}
      importantForAccessibility={accessibilityLabel === undefined ? 'no-hide-descendants' : 'yes'}
    >
      {PARTS.map((part, index) => {
        const out = clock.interpolate(loaderFrames(PART_OFFSETS[index]!, motion.turn, ease))
        const shift = reduce ? 0 : STEP * unit
        return (
          <Animated.View
            key={index}
            style={{
              position: 'absolute',
              left: part.x * unit,
              top: part.y * unit,
              width: part.width * unit,
              height: part.height * unit,
              borderRadius: 2.5 * unit,
              backgroundColor: color ?? colors[index],
              opacity: out.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
              transform: [
                { translateX: out.interpolate({ inputRange: [0, 1], outputRange: [0, part.dx * shift] }) },
                { translateY: out.interpolate({ inputRange: [0, 1], outputRange: [0, part.dy * shift] }) },
              ],
            }}
          />
        )
      })}
    </View>
  )
}

/** A loading state in words: the loader next to the text that says what is loading. */
export function LoadingLine({ text, size = 18, style, textStyle }: { text: string; size?: number; style?: StyleProp<ViewStyle>; textStyle?: StyleProp<TextStyle> }) {
  return (
    <View style={[styles.line, style]} accessibilityLiveRegion="polite">
      <LogoLoader size={size} />
      <Text style={textStyle}>{text}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
})
