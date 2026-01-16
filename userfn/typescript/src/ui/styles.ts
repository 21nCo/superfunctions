export const STYLES = `
  .userfn-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
  }
  .userfn-modal {
    background: white;
    padding: 20px;
    border-radius: 8px;
    max-width: 400px;
    width: 100%;
    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    font-family: system-ui, sans-serif;
  }
  .userfn-title {
    font-size: 1.25rem;
    font-weight: bold;
    margin-bottom: 0.5rem;
  }
  .userfn-body {
    margin-bottom: 1rem;
    color: #4b5563;
  }
  .userfn-cta {
    background: #2563eb;
    color: white;
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.875rem;
  }
  .userfn-cta:hover {
    background: #1d4ed8;
  }
  .userfn-close {
    float: right;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1.5rem;
    line-height: 1;
    color: #9ca3af;
  }
`;

export function injectStyles() {
  if (document.getElementById('userfn-styles')) return;
  const style = document.createElement('style');
  style.id = 'userfn-styles';
  style.textContent = STYLES;
  document.head.appendChild(style);
}
