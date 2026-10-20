import { resolveCampaignUrl } from './campaign-url';
import { Campaign, Survey, SurveyResponse, Question, FeedbackSubmission, FeedbackCategory } from '../types';
import { injectStyles } from './styles';

export class VanillaRenderer {
  private readonly messages = new Set<HTMLElement>();
  private readonly messageTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  constructor(private readonly messagingAllowed: () => boolean = () => true) {
    if (typeof document !== 'undefined') {
      injectStyles();
    }
  }

  dismissMessages(): void { for (const node of [...this.messages]) this.removeMessage(node); }
  private removeMessage(node: HTMLElement): void {
    node.remove(); this.messages.delete(node);
    const timer = this.messageTimers.get(node); if (timer !== undefined) clearTimeout(timer);
    this.messageTimers.delete(node);
  }
  private active(node: HTMLElement): boolean { return this.messagingAllowed() && this.messages.has(node); }

  render(campaign: Campaign, onDismiss: () => void, onAction: () => void) {
    if (!this.messagingAllowed()) return;
    if (campaign.kind === 'modal') {
      this.renderModal(campaign, onDismiss, onAction);
    } else if (campaign.kind === 'inbox-item') {
      this.renderToast(campaign, onDismiss, onAction);
    }
  }

  renderSurvey(survey: Survey, onSubmit: (response: SurveyResponse) => void, onDismiss: () => void) {
    if (!this.messagingAllowed()) return;
    // Start with first question
    this.renderQuestion(survey, 0, [], onSubmit, onDismiss);
  }

  renderFeedbackWidget(onSubmit: (f: FeedbackSubmission) => Promise<void>) {
    const overlay = document.createElement('div');
    overlay.className = 'userfn-overlay';

    const modal = document.createElement('div');
    modal.className = 'userfn-modal';
    modal.style.width = '450px';

    // Close
    const closeBtn = document.createElement('button');
    closeBtn.className = 'userfn-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => document.body.removeChild(overlay);
    modal.appendChild(closeBtn);

    // Title
    const title = document.createElement('h3');
    title.className = 'userfn-title';
    title.innerText = 'Send Feedback';
    modal.appendChild(title);

    // Form Container
    const form = document.createElement('div');
    form.style.display = 'flex';
    form.style.flexDirection = 'column';
    form.style.gap = '12px';

    // Category
    const categoryLabel = document.createElement('label');
    categoryLabel.innerText = 'Category';
    categoryLabel.style.fontSize = '0.9em';
    form.appendChild(categoryLabel);

    const categorySelect = document.createElement('select');
    categorySelect.style.cssText = 'padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
    ['feature', 'bug', 'general'].forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.innerText = cat.charAt(0).toUpperCase() + cat.slice(1);
      categorySelect.appendChild(opt);
    });
    form.appendChild(categorySelect);

    // Title Input
    const titleInput = document.createElement('input');
    titleInput.placeholder = 'Short summary';
    titleInput.style.cssText = 'padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
    form.appendChild(titleInput);

    // Body Input
    const bodyInput = document.createElement('textarea');
    bodyInput.placeholder = 'Describe your feedback...';
    bodyInput.style.cssText = 'padding: 8px; border: 1px solid #ddd; border-radius: 4px; height: 100px; resize: vertical;';
    form.appendChild(bodyInput);

    // Submit Button
    const submitBtn = document.createElement('button');
    submitBtn.className = 'userfn-cta';
    submitBtn.innerText = 'Send Feedback';
    submitBtn.onclick = async () => {
      if (!titleInput.value || !bodyInput.value) {
        alert('Please fill in all fields');
        return;
      }
      
      submitBtn.disabled = true;
      submitBtn.innerText = 'Sending...';

      try {
        await onSubmit({
          title: titleInput.value,
          body: bodyInput.value,
          category: categorySelect.value as FeedbackCategory,
        });
        document.body.removeChild(overlay);
        // Maybe show success toast?
        alert('Feedback sent!');
      } catch (e) {
        submitBtn.disabled = false;
        submitBtn.innerText = 'Send Feedback';
        alert('Failed to send feedback');
      }
    };
    form.appendChild(submitBtn);

    modal.appendChild(form);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  private renderQuestion(
    survey: Survey, 
    index: number, 
    answers: { questionId: string; value: any }[],
    onSubmit: (r: SurveyResponse) => void,
    onDismiss: () => void
  ) {
    if (!this.messagingAllowed()) return;
    if (index >= survey.questions.length) {
      // Done
      onSubmit({
        surveyId: survey.id,
        answers,
        submittedAt: Date.now()
      });
      return;
    }

    const question = survey.questions[index];
    const overlay = document.createElement('div');
    overlay.className = 'userfn-overlay';

    const modal = document.createElement('div');
    modal.className = 'userfn-modal';

    // Close
    const closeBtn = document.createElement('button');
    closeBtn.className = 'userfn-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => {
      if (!this.active(overlay)) return;
      this.removeMessage(overlay);
      onDismiss();
    };
    modal.appendChild(closeBtn);

    // Title
    const title = document.createElement('h3');
    title.className = 'userfn-title';
    title.innerText = question.title;
    modal.appendChild(title);

    // Input Area
    const inputContainer = document.createElement('div');
    inputContainer.style.marginBottom = '1rem';
    
    let getValue: () => any;

    if (question.type === 'nps' || question.type === 'csat') {
      const min = question.min ?? 0;
      const max = question.max ?? 10;
      const range = document.createElement('div');
      range.style.display = 'flex';
      range.style.gap = '8px';
      
      let selected: number | null = null;
      const btns: HTMLButtonElement[] = [];

      for (let i = min; i <= max; i++) {
        const btn = document.createElement('button');
        btn.innerText = String(i);
        btn.style.cssText = 'padding: 8px; border: 1px solid #ddd; border-radius: 4px; background: white; cursor: pointer;';
        btn.onclick = () => {
          if (!this.active(overlay)) return;
          selected = i;
          btns.forEach(b => b.style.background = 'white');
          btn.style.background = '#e5e7eb';
        };
        btns.push(btn);
        range.appendChild(btn);
      }
      inputContainer.appendChild(range);
      getValue = () => selected;
    } else if (question.type === 'text') {
      const area = document.createElement('textarea');
      area.style.cssText = 'width: 100%; height: 80px; padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
      inputContainer.appendChild(area);
      getValue = () => area.value;
    } else {
      // Fallback
      inputContainer.innerText = 'Unsupported question type';
      getValue = () => null;
    }

    modal.appendChild(inputContainer);

    // Next/Submit Button
    const nextBtn = document.createElement('button');
    nextBtn.className = 'userfn-cta';
    nextBtn.innerText = index === survey.questions.length - 1 ? 'Submit' : 'Next';
    nextBtn.onclick = () => {
      if (!this.active(overlay)) return;
      const val = getValue();
      if (question.required && (val === null || val === '')) {
        alert('Please answer the question'); // simple validation
        return;
      }
      this.removeMessage(overlay);
      this.renderQuestion(survey, index + 1, [...answers, { questionId: question.id, value: val }], onSubmit, onDismiss);
    };
    modal.appendChild(nextBtn);

    overlay.appendChild(modal);
    this.messages.add(overlay);
    document.body.appendChild(overlay);
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
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold; margin-bottom:4px';
    title.textContent = campaign.content.title || 'New Message';
    const body = document.createElement('div');
    body.style.cssText = 'color:#666; font-size:0.9em';
    body.textContent = campaign.content.body;
    content.append(title, body);
    toast.appendChild(content);

    const close = document.createElement('button');
    close.innerHTML = '&times;';
    close.style.cssText = 'background:none; border:none; font-size:1.2em; cursor:pointer; color:#999;';
    close.onclick = () => {
      if (!this.active(toast)) return;
      this.removeMessage(toast);
      onDismiss();
    };
    toast.appendChild(close);

    if (resolveCampaignUrl(campaign.content.ctaUrl, window.location.href)) {
      toast.style.cursor = 'pointer';
      content.onclick = () => {
        if (!this.active(toast)) return;
        if (!resolveCampaignUrl(campaign.content.ctaUrl, window.location.href)) return;
        onAction();
        this.removeMessage(toast);
      };
    }

    this.messages.add(toast);
    document.body.appendChild(toast);
    
    // Auto dismiss after 5s
    const timer = setTimeout(() => {
      if (this.active(toast) && document.body.contains(toast)) {
        this.removeMessage(toast);
        onDismiss(); // Count as dismiss or passive?
      }
    }, 5000);
    this.messageTimers.set(toast, timer);
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
      if (!this.active(overlay)) return;
      this.removeMessage(overlay);
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
        if (!this.active(overlay)) return;
        if (campaign.content.ctaUrl !== undefined && !resolveCampaignUrl(campaign.content.ctaUrl, window.location.href)) return;
        this.removeMessage(overlay);
        onAction();
      };
      modal.appendChild(cta);
    }

    overlay.appendChild(modal);
    this.messages.add(overlay);
    document.body.appendChild(overlay);

    // Basic focus trap (very naive)
    modal.focus();
  }
}
