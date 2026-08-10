export function isImage(value: string) {
  const regex = /\.(?:jpe?g|png|webp|avif|gif|svg|bmp|ico|tiff?|heic|apng)$/i

  return regex.test(value)
}

export function inBetween(value: number, minimum: number, maximum: number) {
  return value >= minimum && value <= maximum
}

// 是否是布尔值
export function isBoolean(value: any) {
  if (!value) return false
  return value === true || value.toLowerCase() === 'true' || value === 1 || value === '1'
}
