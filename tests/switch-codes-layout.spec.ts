/**
 * Switch-codes field layout guard (0.2.0-rc.2).
 *
 * jsdom never lays anything out, so the browser-facing widths Hermes measures
 * in the live Plugins page cannot be asserted here. What burned us in rc.1 was
 * the CSS itself: `.switchCodesField` kept the 460px cap from the old narrow
 * Settings dialog column, which truncated the six-code default list once the
 * configuration body moved to the wider Plugins page. The layout was measured
 * in the real browser: 657px card, 607px config column, and 611px of input
 * content (587px of text + 24px horizontal padding) for the default value.
 *
 * Inputs in this bundle are content-box, so a label of N px yields an input
 * whose clientWidth is N + 24 and whose border box is N + 26. To show the
 * default list in full without overhanging the card, the label width must be
 * >= 611 - 24 = 587px and <= the 607px column. This test pins that window and
 * the removal of the dead `white-space: nowrap` / `overflow-x: auto` pair
 * (neither affects a single-line `<input>`, which scrolls its own text).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/FallbackBundleConfig.module.css', import.meta.url), 'utf8')

/** The declaration block of the first rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start === -1) return ''
  return css.slice(start + selector.length, css.indexOf('}', start))
}

const MIN_LABEL_WIDTH = 611 - 24 // measured input content minus its own padding
const MAX_LABEL_WIDTH = 607 // the config column on the verified 657px card

describe('switch-codes field layout', () => {
  it('caps the field so the default six-code list fits its input', () => {
    const body = ruleBody('.switchCodesField')
    expect(body).not.toBe('')
    expect(body).toMatch(/width:\s*100%/)

    const match = /max-width:\s*(\d+(?:\.\d+)?)px/.exec(body)
    expect(match, 'the field must keep an explicit pixel cap').not.toBeNull()
    const maxWidth = Number(match![1])

    expect(maxWidth).toBeGreaterThanOrEqual(MIN_LABEL_WIDTH)
    expect(maxWidth).toBeLessThanOrEqual(MAX_LABEL_WIDTH)
  })

  it('drops the dead nowrap/overflow-x pair from the input', () => {
    // The whole `.switchCodes` class is gone: the declarations never applied to
    // a single-line input, and the value is fully visible by width now.
    expect(css).not.toMatch(/\.switchCodes\s*\{/)
    expect(css).not.toMatch(/white-space:\s*nowrap/)
    expect(css).not.toMatch(/overflow-x/)
  })
})
