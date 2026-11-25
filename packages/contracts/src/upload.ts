const LINKED_UPLOAD_MEDIA_TYPES = ["text/html", "application/xhtml+xml", "application/pdf", "application/epub+zip"] as const

export function linkedUploadMediaType(contentType: string) {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase()
  return LINKED_UPLOAD_MEDIA_TYPES.find((supported) => supported === mediaType)
}
