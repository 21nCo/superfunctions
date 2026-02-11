import { describe, it, expect, vi } from 'vitest';
import {
  FileDropzone,
  UploadProgressList,
  FileList,
  QuotaUsageBar,
  PricingPlans,
  UsageAnalytics,
} from './index.js';

describe('@uifn/files', () => {
  it('should export FileDropzone', () => {
    expect(FileDropzone).toBeDefined();
    expect(typeof FileDropzone).toBe('function');
  });

  it('should export UploadProgressList', () => {
    expect(UploadProgressList).toBeDefined();
    expect(typeof UploadProgressList).toBe('function');
  });

  it('should export FileList', () => {
    expect(FileList).toBeDefined();
    expect(typeof FileList).toBe('function');
  });

  it('should export QuotaUsageBar', () => {
    expect(QuotaUsageBar).toBeDefined();
    expect(typeof QuotaUsageBar).toBe('function');
  });

  it('should export PricingPlans', () => {
    expect(PricingPlans).toBeDefined();
    expect(typeof PricingPlans).toBe('function');
  });

  it('should export UsageAnalytics', () => {
    expect(UsageAnalytics).toBeDefined();
    expect(typeof UsageAnalytics).toBe('function');
  });
});

describe('TV-UI-001: FileDropzone passes selected files to callback', () => {
  it('should call onFiles callback when files are dropped', () => {
    const onFilesMock = vi.fn();
    const dropzone = FileDropzone({ onFiles: onFilesMock });

    const mockFile = new File(['content'], 'avatar.png', { type: 'image/png' });
    const mockEvent = {
      preventDefault: vi.fn(),
      dataTransfer: {
        files: [mockFile],
      },
    } as unknown as DragEvent;

    dropzone.onDrop(mockEvent);

    expect(onFilesMock).toHaveBeenCalledWith([mockFile]);
    expect(onFilesMock).toHaveBeenCalledTimes(1);
    expect(dropzone.state.files).toHaveLength(1);
    expect(dropzone.state.files[0].name).toBe('avatar.png');
  });

  it('should call onFiles callback when files are selected via input', () => {
    const onFilesMock = vi.fn();
    const dropzone = FileDropzone({ onFiles: onFilesMock });

    const mockFile = new File(['content'], 'document.pdf', { type: 'application/pdf' });
    const mockEvent = {
      target: {
        files: [mockFile],
      },
    } as unknown as Event;

    dropzone.onInputChange(mockEvent);

    expect(onFilesMock).toHaveBeenCalledWith([mockFile]);
    expect(dropzone.state.files[0].name).toBe('document.pdf');
  });

  it('should filter files by accept prop', () => {
    const onFilesMock = vi.fn();
    const dropzone = FileDropzone({
      onFiles: onFilesMock,
      accept: ['image/*'],
    });

    const imageFile = new File(['content'], 'avatar.png', { type: 'image/png' });
    const pdfFile = new File(['content'], 'document.pdf', { type: 'application/pdf' });
    const mockEvent = {
      preventDefault: vi.fn(),
      dataTransfer: {
        files: [imageFile, pdfFile],
      },
    } as unknown as DragEvent;

    dropzone.onDrop(mockEvent);

    expect(onFilesMock).toHaveBeenCalledWith([imageFile]);
    expect(dropzone.state.files).toHaveLength(1);
    expect(dropzone.state.files[0].name).toBe('avatar.png');
  });

  it('should respect multiple prop', () => {
    const onFilesMock = vi.fn();
    const dropzone = FileDropzone({
      onFiles: onFilesMock,
      multiple: false,
    });

    const file1 = new File(['content'], 'file1.txt', { type: 'text/plain' });
    const file2 = new File(['content'], 'file2.txt', { type: 'text/plain' });
    const mockEvent = {
      preventDefault: vi.fn(),
      dataTransfer: {
        files: [file1, file2],
      },
    } as unknown as DragEvent;

    dropzone.onDrop(mockEvent);

    expect(onFilesMock).toHaveBeenCalledWith([file1]);
    expect(dropzone.state.files).toHaveLength(1);
  });

  it('should not call callback when disabled', () => {
    const onFilesMock = vi.fn();
    const dropzone = FileDropzone({
      onFiles: onFilesMock,
      disabled: true,
    });

    const mockFile = new File(['content'], 'avatar.png', { type: 'image/png' });
    const mockEvent = {
      preventDefault: vi.fn(),
      dataTransfer: {
        files: [mockFile],
      },
    } as unknown as DragEvent;

    dropzone.onDrop(mockEvent);

    expect(onFilesMock).not.toHaveBeenCalled();
  });

  it('should update isDragging state', () => {
    const dropzone = FileDropzone();

    expect(dropzone.state.isDragging).toBe(false);

    const dragOverEvent = { preventDefault: vi.fn() } as unknown as DragEvent;
    dropzone.onDragOver(dragOverEvent);
    expect(dropzone.state.isDragging).toBe(true);

    const dragLeaveEvent = { preventDefault: vi.fn() } as unknown as DragEvent;
    dropzone.onDragLeave(dragLeaveEvent);
    expect(dropzone.state.isDragging).toBe(false);
  });
});

describe('TV-UI-NEG-001: UI shows policy error state', () => {
  it('should display error code for failed uploads', () => {
    const items = [
      {
        id: 'upload_1',
        fileName: 'document.pdf',
        bytesUploaded: 0,
        bytesTotal: 1000,
        status: 'error' as const,
        error: 'Content type not allowed',
        errorCode: 'FILEFN_POLICY_CONTENT_TYPE_NOT_ALLOWED',
      },
    ];

    const progressList = UploadProgressList({ items });

    const errorDisplay = progressList.getErrorDisplay(items[0]);

    expect(errorDisplay).not.toBeNull();
    expect(errorDisplay?.errorCode).toBe('FILEFN_POLICY_CONTENT_TYPE_NOT_ALLOWED');
    expect(errorDisplay?.shown).toBe(true);
  });

  it('should show different error codes', () => {
    const items = [
      {
        id: 'upload_1',
        fileName: 'large.mp4',
        bytesUploaded: 0,
        bytesTotal: 5000000000,
        status: 'error' as const,
        error: 'File too large',
        errorCode: 'FILEFN_POLICY_SIZE_EXCEEDED',
      },
    ];

    const progressList = UploadProgressList({ items });

    const errorDisplay = progressList.getErrorDisplay(items[0]);

    expect(errorDisplay?.errorCode).toBe('FILEFN_POLICY_SIZE_EXCEEDED');
    expect(errorDisplay?.shown).toBe(true);
  });

  it('should return null for non-error items', () => {
    const items = [
      {
        id: 'upload_1',
        fileName: 'document.pdf',
        bytesUploaded: 500,
        bytesTotal: 1000,
        status: 'uploading' as const,
      },
    ];

    const progressList = UploadProgressList({ items });

    const errorDisplay = progressList.getErrorDisplay(items[0]);

    expect(errorDisplay).toBeNull();
  });
});

describe('TV-UI-PLANS-001: PricingPlans allows selecting a plan', () => {
  it('should call onSelect callback when valid plan is selected', () => {
    const onSelectMock = vi.fn();
    const plans = [
      { id: 'free', name: 'Free', price: 0 },
      { id: 'pro', name: 'Pro', price: 9.99 },
    ];

    const pricingPlans = PricingPlans({
      plans,
      onSelect: onSelectMock,
    });

    const result = pricingPlans.selectPlan('pro');

    expect(result).toBe(true);
    expect(onSelectMock).toHaveBeenCalledWith('pro');
    expect(onSelectMock).toHaveBeenCalledTimes(1);
    expect(pricingPlans.state.selectedPlanId).toBe('pro');
  });

  it('should update selected plan state', () => {
    const plans = [
      { id: 'free', name: 'Free', price: 0 },
      { id: 'pro', name: 'Pro', price: 9.99 },
    ];

    const pricingPlans = PricingPlans({ plans });

    pricingPlans.selectPlan('free');
    expect(pricingPlans.state.selectedPlanId).toBe('free');

    pricingPlans.selectPlan('pro');
    expect(pricingPlans.state.selectedPlanId).toBe('pro');
  });

  it('should get current plan', () => {
    const plans = [
      { id: 'free', name: 'Free', price: 0 },
      { id: 'pro', name: 'Pro', price: 9.99 },
    ];

    const pricingPlans = PricingPlans({ plans });

    pricingPlans.selectPlan('pro');

    const currentPlan = pricingPlans.getCurrentPlan();
    expect(currentPlan).not.toBeNull();
    expect(currentPlan?.id).toBe('pro');
    expect(currentPlan?.name).toBe('Pro');
  });
});

describe('TV-UI-PLANS-NEG-001: PricingPlans handles invalid plan selection', () => {
  it('should not call onSelect callback for invalid plan', () => {
    const onSelectMock = vi.fn();
    const plans = [{ id: 'free', name: 'Free', price: 0 }];

    const pricingPlans = PricingPlans({
      plans,
      onSelect: onSelectMock,
    });

    const result = pricingPlans.selectPlan('pro');

    expect(result).toBe(false);
    expect(onSelectMock).not.toHaveBeenCalled();
    expect(pricingPlans.state.error).toBe('invalid_plan');
  });

  it('should set error state for invalid plan', () => {
    const plans = [
      { id: 'free', name: 'Free', price: 0 },
      { id: 'basic', name: 'Basic', price: 4.99 },
    ];

    const pricingPlans = PricingPlans({ plans });

    pricingPlans.selectPlan('enterprise');

    expect(pricingPlans.state.error).toBe('invalid_plan');
    expect(pricingPlans.state.selectedPlanId).toBeNull();
  });

  it('should validate plan exists', () => {
    const plans = [{ id: 'free', name: 'Free', price: 0 }];

    const pricingPlans = PricingPlans({ plans });

    expect(pricingPlans.isValidPlan('free')).toBe(true);
    expect(pricingPlans.isValidPlan('pro')).toBe(false);
    expect(pricingPlans.isValidPlan('enterprise')).toBe(false);
  });

  it('should clear error on valid selection', () => {
    const plans = [
      { id: 'free', name: 'Free', price: 0 },
      { id: 'pro', name: 'Pro', price: 9.99 },
    ];

    const pricingPlans = PricingPlans({ plans });

    pricingPlans.selectPlan('invalid');
    expect(pricingPlans.state.error).toBe('invalid_plan');

    pricingPlans.selectPlan('free');
    expect(pricingPlans.state.error).toBeUndefined();
  });
});

describe('UploadProgressList', () => {
  it('should calculate upload progress percentage', () => {
    const items = [
      {
        id: 'upload_1',
        fileName: 'file.txt',
        bytesUploaded: 500,
        bytesTotal: 1000,
        status: 'uploading' as const,
      },
    ];

    const progressList = UploadProgressList({ items });

    expect(progressList.getProgress(items[0])).toBe(50);
  });

  it('should allow canceling pending/uploading items', () => {
    const onCancelMock = vi.fn();
    const items = [
      {
        id: 'upload_1',
        fileName: 'file.txt',
        bytesUploaded: 0,
        bytesTotal: 1000,
        status: 'uploading' as const,
      },
    ];

    const progressList = UploadProgressList({ items, onCancel: onCancelMock });

    expect(progressList.canCancel(items[0])).toBe(true);
    progressList.onCancel('upload_1');
    expect(onCancelMock).toHaveBeenCalledWith('upload_1');
  });

  it('should allow retrying failed items', () => {
    const onRetryMock = vi.fn();
    const items = [
      {
        id: 'upload_1',
        fileName: 'file.txt',
        bytesUploaded: 0,
        bytesTotal: 1000,
        status: 'error' as const,
        error: 'Network error',
      },
    ];

    const progressList = UploadProgressList({ items, onRetry: onRetryMock });

    expect(progressList.canRetry(items[0])).toBe(true);
    progressList.onRetry('upload_1');
    expect(onRetryMock).toHaveBeenCalledWith('upload_1');
  });
});

describe('QuotaUsageBar', () => {
  it('should calculate usage percentage', () => {
    const quotaBar = QuotaUsageBar({
      used: 50,
      limit: 100,
    });

    expect(quotaBar.state.percentage).toBe(50);
    expect(quotaBar.state.isWarning).toBe(false);
    expect(quotaBar.state.isExceeded).toBe(false);
  });

  it('should detect warning state', () => {
    const quotaBar = QuotaUsageBar({
      used: 85,
      limit: 100,
      warningThreshold: 0.8,
    });

    expect(quotaBar.state.isWarning).toBe(true);
    expect(quotaBar.state.isExceeded).toBe(false);
    expect(quotaBar.getUsageLevel()).toBe('warning');
  });

  it('should detect exceeded state', () => {
    const quotaBar = QuotaUsageBar({
      used: 120,
      limit: 100,
    });

    expect(quotaBar.state.isExceeded).toBe(true);
    expect(quotaBar.state.isWarning).toBe(false);
    expect(quotaBar.getUsageLevel()).toBe('exceeded');
  });

  it('should format bytes', () => {
    const quotaBar = QuotaUsageBar({ used: 0, limit: 0 });

    expect(quotaBar.formatBytes(0)).toBe('0 B');
    expect(quotaBar.formatBytes(1024)).toBe('1 KB');
    expect(quotaBar.formatBytes(1048576)).toBe('1 MB');
    expect(quotaBar.formatBytes(1073741824)).toBe('1 GB');
  });

  it('should calculate available space', () => {
    const quotaBar = QuotaUsageBar({
      used: 30,
      limit: 100,
    });

    expect(quotaBar.state.available).toBe(70);
  });
});

describe('FileList', () => {
  it('should select file and call callback', () => {
    const onSelectMock = vi.fn();
    const files = [
      {
        id: 'file_1',
        name: 'document.pdf',
        size: 1000,
        mimeType: 'application/pdf',
        createdAt: new Date(),
      },
    ];

    const fileList = FileList({ files, onSelect: onSelectMock });

    fileList.selectFile(files[0]);

    expect(onSelectMock).toHaveBeenCalledWith(files[0]);
    expect(fileList.state.selectedFileId).toBe('file_1');
  });

  it('should delete file and call callback', () => {
    const onDeleteMock = vi.fn();
    const files = [
      {
        id: 'file_1',
        name: 'document.pdf',
        size: 1000,
        mimeType: 'application/pdf',
        createdAt: new Date(),
      },
    ];

    const fileList = FileList({ files, onDelete: onDeleteMock });

    fileList.deleteFile(files[0]);

    expect(onDeleteMock).toHaveBeenCalledWith(files[0]);
  });

  it('should sort files', () => {
    const files = [
      {
        id: 'file_1',
        name: 'b.txt',
        size: 1000,
        mimeType: 'text/plain',
        createdAt: new Date('2024-01-01'),
      },
      {
        id: 'file_2',
        name: 'a.txt',
        size: 500,
        mimeType: 'text/plain',
        createdAt: new Date('2024-01-02'),
      },
    ];

    const fileList = FileList({ files });

    const sorted = fileList.sortBy('name', 'asc');

    expect(sorted[0].name).toBe('a.txt');
    expect(sorted[1].name).toBe('b.txt');
  });
});

describe('UsageAnalytics', () => {
  it('should calculate storage percentage', () => {
    const analytics = UsageAnalytics({
      data: {
        storageUsed: 50,
        storageLimit: 100,
        uploadCount: 10,
        downloadCount: 20,
      },
    });

    expect(analytics.state.storagePercentage).toBe(50);
    expect(analytics.state.isStorageWarning).toBe(false);
  });

  it('should detect storage warning', () => {
    const analytics = UsageAnalytics({
      data: {
        storageUsed: 85,
        storageLimit: 100,
        uploadCount: 10,
        downloadCount: 20,
      },
    });

    expect(analytics.state.isStorageWarning).toBe(true);
  });

  it('should calculate total activity', () => {
    const analytics = UsageAnalytics({
      data: {
        storageUsed: 50,
        storageLimit: 100,
        uploadCount: 15,
        downloadCount: 25,
      },
    });

    expect(analytics.getTotalActivity()).toBe(40);
  });

  it('should provide activity breakdown', () => {
    const analytics = UsageAnalytics({
      data: {
        storageUsed: 50,
        storageLimit: 100,
        uploadCount: 15,
        downloadCount: 25,
      },
    });

    const breakdown = analytics.getBreakdown();

    expect(breakdown.uploads).toBe(15);
    expect(breakdown.downloads).toBe(25);
  });

  it('should format storage usage text', () => {
    const analytics = UsageAnalytics({
      data: {
        storageUsed: 1048576,
        storageLimit: 10485760,
        uploadCount: 10,
        downloadCount: 20,
      },
    });

    const usageText = analytics.getStorageUsageText();

    expect(usageText).toContain('MB');
  });
});
