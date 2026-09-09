/**
 * The numbers shown on the unnamed entries, counted through the song from the start: the
 * flags read 1, 2, 3 left to right whatever order they were made in, and naming one takes
 * it out of the count rather than leaving a gap. Markers and loops each call this on their
 * own, so each kind has its own counter.
 *
 * Returns one entry per item, in the order given: the number for an unnamed one,
 * `undefined` for a named one.
 */
export const autoNumbers = (items: { at: number; name?: string }[]): (number | undefined)[] => {
  const numbers: (number | undefined)[] = items.map(() => undefined)
  items
    .flatMap((item, index) => (item.name ? [] : [{ at: item.at, index }]))
    .sort((a, b) => a.at - b.at)
    .forEach((item, count) => (numbers[item.index] = count + 1))
  return numbers
}
