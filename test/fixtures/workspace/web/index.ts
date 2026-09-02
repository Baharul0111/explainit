export function mount(selector: string): void {
  const el = document.querySelector(selector);
  if (el) {
    el.textContent = 'mounted';
  }
}
