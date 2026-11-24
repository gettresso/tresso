/**
 * The two letters on an app's mark, from the name it gave itself: the first letters of its first two words ("Calendar
 * bridge" is CB), else its first two capitals ("ChatGPT" is CG), else its first two letters ("Claude" is CL).
 */
export function appInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => /\p{L}|\p{N}/u.test(word))
  if (words.length > 1) return (Array.from(words[0]!)[0]! + Array.from(words[1]!)[0]!).toUpperCase()
  const word = words[0] ?? ''
  const capitals = Array.from(word).filter((letter) => /\p{Lu}/u.test(letter))
  if (capitals.length >= 2) return capitals.slice(0, 2).join('')
  return Array.from(word).slice(0, 2).join('').toUpperCase()
}
