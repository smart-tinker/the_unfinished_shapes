    }
  }
  finally { editing = false; const object = objectData.get(selectedId); $('edit-fields').disabled = !object || !(role === 'admin' || (role === 'builder' && object.ownerId === meId)); }
});
function setFullscreenState(value) {
  isFullscreen = value === true;
  const button = $('fullscreen-toggle');
  button.textContent = isFullscreen ? 'Exit full screen' : 'Full screen';
  button.setAttribute('aria-pressed', String(isFullscreen));
  button.title = isFullscreen ? 'Exit full screen (F11 or Escape)' : 'Enter full screen (F11)';
  $('fullscreen-status').textContent = '';
}
function requestFullscreenToggle() {
  bridge.toggleFullscreen().catch(error => { $('fullscreen-status').textContent = `Fullscreen failed: ${error.message}`; });
}
bridge.onFullscreenChange(setFullscreenState);
$('fullscreen-toggle').addEventListener('click', requestFullscreenToggle);
setFullscreenState(false);
window.addEventListener('keydown', event => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.querySelector('dialog[open]')) return;
  if (event.code === 'Escape' && (dragCandidate || movePreview)) { event.preventDefault(); cancelMovePreview(); return; }
  if (event.code === 'F11') { event.preventDefault(); if (!event.repeat) requestFullscreenToggle(); return; }
  if (event.code === 'Escape' && isFullscreen) { event.preventDefault(); requestFullscreenToggle(); return; }
  if (event.code === 'Space') { event.preventDefault(); if (!event.repeat) jumpRequested = true; return; }
  keys.add(event.key.toLowerCase());
});