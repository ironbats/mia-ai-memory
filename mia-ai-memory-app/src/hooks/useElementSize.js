import { useLayoutEffect, useState } from "react"

export default function useElementSize(ref, enabled = true) {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = ref.current
    if (!enabled || !element) return
    const measure = () => {
      const { width, height } = element.getBoundingClientRect()
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, enabled])
  return size
}
