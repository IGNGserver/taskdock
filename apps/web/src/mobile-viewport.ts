/** Keep the application and its portals inside the area above the software keyboard. */
export function installMobileViewport(): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => undefined;
  const root = document.documentElement;
  const update = () => {
    // Preserve pinch zoom; zooming must not resize the application beneath the user.
    if (viewport.scale !== 1) return;
    root.style.setProperty('--dt-viewport-height', `${viewport.height}px`);
    root.style.setProperty('--dt-viewport-top', `${viewport.offsetTop}px`);
    const editing = document.activeElement?.matches('input, textarea, [contenteditable="true"]');
    root.classList.toggle(
      'keyboard-visible',
      !!editing && window.innerHeight - viewport.height > 120,
    );
  };
  update();
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  document.addEventListener('focusin', update);
  document.addEventListener('focusout', update);
  return () => {
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
    document.removeEventListener('focusin', update);
    document.removeEventListener('focusout', update);
    root.style.removeProperty('--dt-viewport-height');
    root.style.removeProperty('--dt-viewport-top');
    root.classList.remove('keyboard-visible');
  };
}
