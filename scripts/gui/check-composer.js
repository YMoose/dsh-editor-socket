// Pass this content as Chrome DevTools evaluate_script's function argument.
// sourcePath also works when the MCP server allows reading this checkout.
// Read-only: first create a real editor reference using the VS Code GUI.
() => {
  const rail = document.querySelector('[data-editor-socket]')
  const card = rail?.closest('[data-composer-card]')
  const editor = card?.querySelector('[role="textbox"]')
  const chip = rail?.querySelector('.editor-socket-chip')
  const assert = (ok, message) => { if (!ok) throw new Error(message) }
  assert(rail && card && editor && chip, 'Editor reference must be inside the composer card')
  const r = chip.getBoundingClientRect()
  const c = card.getBoundingClientRect()
  const e = editor.getBoundingClientRect()
  assert(r.left >= c.left && r.right <= c.right && r.top >= c.top, 'Reference escapes the card')
  assert(r.bottom <= e.top, 'Reference overlaps the draft editor')
  const buttons = rail.querySelectorAll('button')
  assert(buttons.length === 1 && !!buttons[0].getAttribute('aria-label'), 'Only one accessible remove button is expected')
  assert(document.documentElement.scrollWidth <= window.innerWidth, 'Page overflows horizontally')
  return {
    width: window.innerWidth, reference: chip.textContent,
    insideCard: true, noOverlap: true, noOverflow: true,
    chipHeight: r.height, cardHeight: c.height,
    fullPathAndHint: chip.title,
  }
}
