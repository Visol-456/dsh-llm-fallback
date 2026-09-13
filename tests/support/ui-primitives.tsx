/**
 * Test support: minimal stand-ins for the UI primitives the Fallback section
 * uses. The real browser package is a module-loader bundle whose full shiki /
 * markdown dependency graph has no Node-side test story; the section only
 * relies on button passthrough and icon rendering.
 * @module test/support/ui-primitives
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: string
  size?: string
  icon?: ReactNode
}

/** Minimal Button: forwards native button props and renders the icon slot. */
export function Button({ variant: _variant, size: _size, icon, children, ...props }: ButtonProps): JSX.Element {
  return <button {...props}>{icon}{children}</button>
}

/** Minimal decorative icon stand-in. */
function Icon(): JSX.Element {
  return <span aria-hidden="true" />
}

export const IconChevronDownOutline14 = Icon
export const IconChevronUpOutline14 = Icon
export const IconPlusOutline16 = Icon
export const IconRefreshOutline16 = Icon
export const IconTrashOutline16 = Icon
