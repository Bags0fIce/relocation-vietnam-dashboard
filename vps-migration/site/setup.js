const form = document.querySelector('#setup-form');
const message = document.querySelector('#setup-message');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  if (data.password !== data.confirm_password) { message.textContent = 'The passwords do not match.'; return; }
  try {
    const response = await fetch('/api/auth/bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json().catch(() => ({ error: { message: 'Server response could not be read.' } }));
    message.textContent = result.error?.message || result.data?.message || 'Setup complete.';
    if (response.ok) form.remove();
  } catch { message.textContent = 'The server could not be reached. Try again when the connection is available.'; }
});
