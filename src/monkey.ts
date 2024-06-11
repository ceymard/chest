

if (typeof Map.groupBy !== "function") {
  Map.groupBy = function groupBy<K, T>(
      items: Iterable<T>,
      keySelector: (item: T, index: number) => K,
  ): Map<K, T[]> {
    const res = new Map()

    let i = 0
    for (let item of items) {
      const sel = keySelector(item, i++)

      let arr = res.get(sel)
      if (arr == null) {
        arr = []
        res.set(sel, arr)
      }

      arr.push(item)
    }

    return res
  }
}