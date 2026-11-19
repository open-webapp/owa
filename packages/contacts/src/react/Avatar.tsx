import { useState } from 'react'

export interface AvatarProps {
  email?: string
  name?: string
  photoUrl?: string
  size?: number
}

export function initialsFor(name?: string, email?: string): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (words.length) return words.slice(0, 2).map((w) => Array.from(w)[0]!.toUpperCase()).join('')
  const local = (email ?? '').split('@')[0] ?? ''
  return local ? Array.from(local)[0]!.toUpperCase() : '?'
}

export function Avatar({ email, name, photoUrl, size = 32 }: AvatarProps) {
  const [failed, setFailed] = useState<string | undefined>()
  const showImg = !!photoUrl && failed !== photoUrl
  return (
    <span className="contacts-avatar" style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {showImg ? (
        <img className="contacts-avatar__img" src={photoUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailed(photoUrl)} />
      ) : (
        <span className="contacts-avatar__initials">{initialsFor(name, email)}</span>
      )}
    </span>
  )
}
