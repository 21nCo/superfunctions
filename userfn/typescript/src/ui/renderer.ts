import { resolveCampaignUrl } from './campaign-url';
import { Campaign, Survey, SurveyResponse, FeedbackSubmission, FeedbackCategory } from '../types';
import { injectStyles } from './styles';
import { surveyQuestionVisible, surveyScaleBounds, validateSurveyBranches } from '../core/survey-questions';

type SurveySubmit = (response: SurveyResponse) => void | false | 'local' | 'stored' | Promise<void | false | 'local' | 'stored'>;

export class VanillaRenderer {
  private readonly dialogs = new Map<HTMLElement, () => void>();
  private readonly feedbackNodes = new Set<HTMLElement>();
  private readonly surveyNodes = new Set<HTMLElement>();
  private readonly messages = new Set<HTMLElement>();
  private readonly messageTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  constructor(private readonly messagingAllowed: () => boolean = () => true) {
    if (typeof document !== 'undefined') {
      injectStyles();
    }
  }

  dismissFeedback(): void { for (const node of [...this.feedbackNodes]) this.removeMessage(node); }
  dismissSurveys(): void { for (const node of [...this.surveyNodes]) this.removeMessage(node); }
  dismissMessages(): void { for (const node of [...this.messages]) this.removeMessage(node); }
  private removeMessage(node: HTMLElement): void {
    const cleanup = this.dialogs.get(node); this.dialogs.delete(node);
    node.remove();
    this.feedbackNodes.delete(node);
    cleanup?.(); this.messages.delete(node); this.surveyNodes.delete(node);
    const timer = this.messageTimers.get(node); if (timer !== undefined) clearTimeout(timer);
    this.messageTimers.delete(node);
  }
  private active(node: HTMLElement): boolean { return this.messagingAllowed() && this.messages.has(node); }

  private manageDialog(overlay: HTMLElement, modal: HTMLElement, close: HTMLButtonElement, label: string): void {
    const previous = document.activeElement;
    modal.tabIndex = -1;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', label);
    const top = () => [...this.dialogs.keys()].pop() === overlay;
    const controls = () => [...modal.querySelectorAll<HTMLElement>('button,input,textarea,select,a[href],[tabindex]')]
      .filter(node => node.tabIndex >= 0 && !(node as HTMLInputElement).disabled && node.getClientRects().length > 0);
    const focus = () => (controls()[0] ?? modal).focus();
    const keydown = (event: KeyboardEvent) => {
      if (!top()) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.click(); }
      if (event.key !== 'Tab') return;
      const items = controls(); const first = items[0]; const last = items[items.length - 1];
      if (!first) { event.preventDefault(); modal.focus(); }
      else if (!modal.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last) || document.activeElement === modal) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    };
    const focusin = () => { if (top() && !modal.contains(document.activeElement)) focus(); };
    this.dialogs.set(overlay, () => {
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', focusin);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    });
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focusin);
    focus();
  }

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
    validateSurveyBranches(survey.questions);
    // Start with first question
    this.renderQuestion(survey, pending ? survey.questions.length : 0, pending?.answers ?? [], onSubmit, onDismiss, pending);
  }

  renderFeedbackWidget(onSubmit: (f: FeedbackSubmission) => Promise<void>) {
    for (const node of [...this.feedbackNodes]) this.removeMessage(node);
    const overlay = document.createElement('div');
    overlay.className = 'userfn-overlay';

    const modal = document.createElement('div');
    modal.className = 'userfn-modal';
    modal.style.width = '450px';

    // Close
    const closeBtn = document.createElement('button');
    closeBtn.className = 'userfn-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.setAttribute('aria-label', 'Close feedback');
    closeBtn.onclick = () => this.removeMessage(overlay);
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
    categorySelect.setAttribute('aria-label', 'Category');
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
    titleInput.setAttribute('aria-label', 'Feedback title');
    titleInput.maxLength = 200;
    titleInput.style.cssText = 'padding: 8px; border: 1px solid #ddd; border-radius: 4px;';
    form.appendChild(titleInput);

    // Body Input
    const bodyInput = document.createElement('textarea');
    bodyInput.placeholder = 'Describe your feedback...';
    bodyInput.setAttribute('aria-label', 'Feedback details');
    bodyInput.maxLength = 20000;
    bodyInput.style.cssText = 'padding: 8px; border: 1px solid #ddd; border-radius: 4px; height: 100px; resize: vertical;';
    form.appendChild(bodyInput);

    // Submit Button
    const submitBtn = document.createElement('button');
    submitBtn.className = 'userfn-cta';
    submitBtn.innerText = 'Send Feedback';
    const status = document.createElement('p');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    let snapshot: FeedbackSubmission | undefined;
    let sending = false; let completed = false;
    submitBtn.onclick = async () => {
      if (sending || completed || !this.feedbackNodes.has(overlay)) return;
      if (!snapshot) {
        if (!titleInput.value.trim() || !bodyInput.value.trim()) {
          status.textContent = 'Please provide a title and details.';
          (!titleInput.value.trim() ? titleInput : bodyInput).focus(); return;
        }
        snapshot = { title: titleInput.value, body: bodyInput.value, category: categorySelect.value as FeedbackCategory };
      }
      sending = true; submitBtn.disabled = true; submitBtn.innerText = 'Sending…';
      titleInput.disabled = true; bodyInput.disabled = true; categorySelect.disabled = true;
      status.textContent = 'Submitting your feedback…';
      try {
        await onSubmit({ ...snapshot });
        if (!this.feedbackNodes.has(overlay)) return;
        completed = true; status.textContent = 'Feedback sent.'; submitBtn.innerText = 'Submitted';
      } catch {
        if (!this.feedbackNodes.has(overlay)) return;
        status.textContent = 'Delivery not confirmed. Keep this dialog open; retry sends the same feedback.';
        submitBtn.disabled = false; submitBtn.innerText = 'Retry feedback';
      } finally { sending = false; }
    };
    form.appendChild(status);
    form.appendChild(submitBtn);

    modal.appendChild(form);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this.feedbackNodes.add(overlay);
    this.manageDialog(overlay, modal, closeBtn, 'Send feedback');
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
    while (!pending && index < survey.questions.length && !surveyQuestionVisible(survey.questions[index], answers)) index++;
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
    } else if (question && ['nps', 'csat', 'ces', 'scale'].includes(question.type)) {
      const { min, max } = surveyScaleBounds(question);
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
    this.manageDialog(overlay, modal, closeBtn, survey.title ?? 'Survey');
  }

  private renderToast(campaign: Campaign, onDismiss: () => void, onAction: () => void) {
    const toast = document.createElement('div');
    toast.className = 'userfn-toast';
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
    closeBtn.setAttribute('aria-label', 'Close message');
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

    this.manageDialog(overlay, modal, closeBtn, campaign.content.title ?? 'Message');
  }
}
