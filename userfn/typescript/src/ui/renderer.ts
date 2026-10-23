import { resolveCampaignUrl } from './campaign-url';
import { Campaign, Survey, SurveyResponse, FeedbackSubmission, FeedbackCategory } from '../types';
import { injectStyles } from './styles';

type SurveySubmit = (response: SurveyResponse) => void | false | 'local' | 'stored' | Promise<void | false | 'local' | 'stored'>;

export class VanillaRenderer {
  private readonly surveyNodes = new Set<HTMLElement>();
  private readonly messages = new Set<HTMLElement>();
  private readonly messageTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  constructor(private readonly messagingAllowed: () => boolean = () => true) {
    if (typeof document !== 'undefined') {
      injectStyles();
    }
  }

  dismissSurveys(): void { for (const node of [...this.surveyNodes]) this.removeMessage(node); }
  dismissMessages(): void { for (const node of [...this.messages]) this.removeMessage(node); }
  private removeMessage(node: HTMLElement): void {
    node.remove(); this.messages.delete(node); this.surveyNodes.delete(node);
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

  renderSurvey(survey: Survey, onSubmit: SurveySubmit, onDismiss: () => void, pending?: SurveyResponse) {
    if (!this.messagingAllowed()) return;
    // Start with first question
    this.renderQuestion(survey, pending ? survey.questions.length : 0, pending?.answers ?? [], onSubmit, onDismiss, pending);
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
    answers: SurveyResponse['answers'],
    onSubmit: SurveySubmit,
    onDismiss: () => void,
    pending?: SurveyResponse,
  ) {
    if (!this.messagingAllowed()) return;
    const question = survey.questions[index];
    const overlay = document.createElement('div');
    overlay.className = 'userfn-overlay';
    const modal = document.createElement('div');
    modal.className = 'userfn-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', survey.title ?? 'Survey');
    const closeBtn = document.createElement('button');
    closeBtn.className = 'userfn-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Close survey');
    closeBtn.onclick = () => { if (this.active(overlay)) { this.removeMessage(overlay); onDismiss(); } };
    modal.appendChild(closeBtn);
    const title = document.createElement('h3');
    title.className = 'userfn-title';
    title.textContent = question?.title ?? survey.title ?? 'Survey response';
    modal.appendChild(title);
    const inputs = document.createElement('div');
    inputs.style.marginBottom = '1rem';
    let getValue: () => unknown = () => null;
    let unsupported = false;
    if (pending) {
      const note = document.createElement('p');
      note.textContent = 'A previous submission has not been confirmed here. Retry sends the same answers.';
      inputs.appendChild(note);
      const summary = document.createElement('ul');
      for (const answer of pending.answers) {
        const item = document.createElement('li');
        item.textContent = `${survey.questions.find(q => q.id === answer.questionId)?.title ?? answer.questionId}: ${String(answer.value)}`;
        summary.appendChild(item);
      }
      inputs.appendChild(summary);
    } else if (question?.type === 'nps' || question?.type === 'csat') {
      const min = question.min ?? (question.type === 'csat' ? 1 : 0);
      const max = question.max ?? (question.type === 'csat' ? 5 : 10);
      let selected: number | null = null;
      const buttons: HTMLButtonElement[] = [];
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max || max - min > 100) unsupported = true;
      else for (let value = min; value <= max; value++) {
        const button = document.createElement('button');
        button.textContent = String(value);
        button.setAttribute('aria-pressed', 'false');
        button.onclick = () => {
          if (!this.active(overlay) || button.disabled) return;
          selected = value;
          buttons.forEach(other => other.setAttribute('aria-pressed', String(other === button)));
        };
        buttons.push(button); inputs.appendChild(button);
      }
      getValue = () => selected;
    } else if (question?.type === 'choice') {
      const select = document.createElement('select');
      select.setAttribute('aria-label', question.title);
      const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Choose an answer'; select.appendChild(empty);
      for (const [choiceIndex, choice] of (question.choices ?? []).entries()) {
        const option = document.createElement('option'); option.value = String(choiceIndex); option.textContent = choice.label; select.appendChild(option);
      }
      inputs.appendChild(select);
      getValue = () => select.value === '' ? null : question.choices?.[Number(select.value)]?.value;
    } else if (question?.type === 'text') {
      const area = document.createElement('textarea');
      area.setAttribute('aria-label', question.title);
      area.maxLength = 10000;
      inputs.appendChild(area); getValue = () => area.value;
    } else if (question) unsupported = true;
    if (unsupported) inputs.textContent = 'This question cannot be displayed.';
    modal.appendChild(inputs);
    const status = document.createElement('p');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    modal.appendChild(status);
    const next = document.createElement('button'); next.className = 'userfn-cta';
    const final = index >= survey.questions.length - 1;
    next.textContent = pending ? 'Retry submission' : final ? 'Submit' : 'Next';
    next.disabled = unsupported;
    let frozen = pending;
    let sending = false;
    let completed = false;
    next.onclick = async () => {
      if (!this.active(overlay) || sending || completed || unsupported) return;
      if (!frozen) {
        const value = getValue();
        const empty = value === null || value === undefined || (typeof value === 'string' && !value.trim());
        if (question?.required && empty) { status.textContent = 'Please answer the question.'; return; }
        const collected = question && !empty ? [...answers, { questionId: question.id, value }] : answers;
        if (!final) { this.removeMessage(overlay); this.renderQuestion(survey, index + 1, collected, onSubmit, onDismiss); return; }
        frozen = { surveyId: survey.id, answers: collected, submittedAt: Date.now() };
      }
      sending = true; next.disabled = true; next.textContent = 'Sending…'; status.textContent = 'Submitting your response…';
      inputs.querySelectorAll('button,input,textarea,select').forEach(input => { (input as HTMLInputElement).disabled = true; });
      try {
        const acknowledgement = await onSubmit(frozen);
        if (!this.active(overlay)) return;
        if (acknowledgement === false) { status.textContent = 'This survey is no longer active.'; next.textContent = 'Unavailable'; return; }
        completed = true;
        status.textContent = acknowledgement === 'stored' ? 'Response saved.' : 'Response recorded locally.';
        next.textContent = 'Submitted';
      } catch {
        if (!this.active(overlay)) return;
        status.textContent = 'Submission not confirmed. Retry sends the same answers. Keep this page open to retry.';
        next.disabled = false; next.textContent = 'Retry submission';
      } finally { sending = false; }
    };
    modal.appendChild(next); overlay.appendChild(modal);
    this.messages.add(overlay); this.surveyNodes.add(overlay); document.body.appendChild(overlay);
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
