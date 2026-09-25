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

/** The 0.1.7 icon set names each artwork by stroke weight. */
export const IconChevronDownOutlineRegular = Icon
export const IconChevronUpOutlineRegular = Icon
export const IconPlusOutlineRegular = Icon
export const IconRefreshOutlineRegular = Icon
export const IconTrashOutlineRegular = Icon
export const IconChevronDownOutlineMedium = Icon
export const IconChevronUpOutlineMedium = Icon
export const IconPlusOutlineMedium = Icon
export const IconRefreshOutlineMedium = Icon
export const IconTrashOutlineMedium = Icon
