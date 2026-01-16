import { Campaign } from '../types';
import { injectStyles } from './styles';

export class VanillaRenderer {
  constructor() {
    if (typeof document !== 'undefined') {
      injectStyles();
    }
  }

  render(campaign: Campaign, onDismiss: () => void, onAction: () => void) {
    if (campaign.kind === 'modal') {
      this.renderModal(campaign, onDismiss, onAction);
    } else if (campaign.kind === 'inbox-item') {
      // Inbox usually doesn't "render" actively like a modal, 
      // but if triggered, maybe it opens a toast or the inbox widget?
      // For now, let's treat it as a Toast/Notification for the new message
      this.renderToast(campaign, onDismiss, onAction);
    }
  }

  private renderToast(campaign: Campaign, onDismiss: () => void, onAction: () => void) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed; bottom: 20px; right: 20px;
      background: white; padding: 16px; border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 10000; display: flex; gap: 12px; align-items: flex-start;
      font-family: system-ui; max-width: 320px;
      animation: slideIn 0.3s ease-out;
    `;
    
    // Animation style
    const style = document.createElement('style');
    style.textContent = `@keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }`;
    toast.appendChild(style);

    const content = document.createElement('div');
    content.innerHTML = `
      <div style="font-weight:bold; margin-bottom:4px">${campaign.content.title || 'New Message'}</div>
      <div style="color:#666; font-size:0.9em">${campaign.content.body}</div>
    `;
    toast.appendChild(content);

    const close = document.createElement('button');
    close.innerHTML = '&times;';
    close.style.cssText = 'background:none; border:none; font-size:1.2em; cursor:pointer; color:#999;';
    close.onclick = () => {
      document.body.removeChild(toast);
      onDismiss();
    };
    toast.appendChild(close);

    if (campaign.content.ctaUrl) {
      toast.style.cursor = 'pointer';
      content.onclick = () => {
        onAction();
        document.body.removeChild(toast);
      };
    }

    document.body.appendChild(toast);
    
    // Auto dismiss after 5s
    setTimeout(() => {
      if (document.body.contains(toast)) {
        document.body.removeChild(toast);
        onDismiss(); // Count as dismiss or passive?
      }
    }, 5000);
  }

  private renderModal(campaign: Campaign, onDismiss: () => void, onAction: () => void) {
    const overlay = document.createElement('div');
    overlay.className = 'userfn-overlay';

    const modal = document.createElement('div');
    modal.className = 'userfn-modal';

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'userfn-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => {
      document.body.removeChild(overlay);
      onDismiss();
    };
    modal.appendChild(closeBtn);

    // Title
    if (campaign.content.title) {
      const title = document.createElement('h3');
      title.className = 'userfn-title';
      title.innerText = campaign.content.title;
      modal.appendChild(title);
    }

    // Body
    const body = document.createElement('p');
    body.className = 'userfn-body';
    body.innerText = campaign.content.body;
    modal.appendChild(body);

    // CTA
    if (campaign.content.ctaText) {
      const cta = document.createElement('button');
      cta.className = 'userfn-cta';
      cta.innerText = campaign.content.ctaText;
      cta.onclick = () => {
        document.body.removeChild(overlay);
        onAction();
      };
      modal.appendChild(cta);
    }

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Basic focus trap (very naive)
    modal.focus();
  }
}
