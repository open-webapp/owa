import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { Avatar } from '../Avatar'

afterEach(cleanup)

describe('Avatar', () => {
  it('shows img for photoUrl', () => {
    const { container } = render(<Avatar name="Ada Lovelace" photoUrl="https://x/y.png" />)
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://x/y.png')
  })
  it('two-word name -> AL', () => {
    render(<Avatar name="Ada Lovelace" />)
    expect(screen.getByText('AL')).toBeInTheDocument()
  })
  it('single name -> A', () => {
    render(<Avatar name="Ada" />)
    expect(screen.getByText('A')).toBeInTheDocument()
  })
  it('no name -> email local-part initial', () => {
    render(<Avatar email="zed@example.com" />)
    expect(screen.getByText('Z')).toBeInTheDocument()
  })
  it('img error -> initials', () => {
    const { container } = render(<Avatar name="Ada Lovelace" photoUrl="https://x/bad.png" />)
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('AL')).toBeInTheDocument()
  })
})
