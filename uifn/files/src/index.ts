export interface FileDropzoneState {
  isDragging: boolean;
  files: File[];
}

export interface FileDropzoneProps {
  onFiles?: (files: File[]) => void;
  accept?: string[];
  multiple?: boolean;
  disabled?: boolean;
}

export function createFileDropzone(_props?: FileDropzoneProps) {
  return {
    state: { isDragging: false, files: [] } as FileDropzoneState,
    onDragOver: () => {},
    onDragLeave: () => {},
    onDrop: () => {},
  };
}

export interface UploadProgressItem {
  id: string;
  fileName: string;
  bytesUploaded: number;
  bytesTotal: number;
  status: 'pending' | 'uploading' | 'completed' | 'error';
  error?: string;
}

export interface UploadProgressListProps {
  items: UploadProgressItem[];
  onCancel?: (id: string) => void;
  onRetry?: (id: string) => void;
}

export function createUploadProgressList(_props?: UploadProgressListProps) {
  return {
    items: [] as UploadProgressItem[],
  };
}

export interface FileListItem {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  createdAt: Date;
}

export interface FileListProps {
  files: FileListItem[];
  onSelect?: (file: FileListItem) => void;
  onDelete?: (file: FileListItem) => void;
}

export function createFileList(_props?: FileListProps) {
  return {
    files: [] as FileListItem[],
  };
}

export interface QuotaUsageBarProps {
  used: number;
  limit: number;
  warningThreshold?: number;
}

export function createQuotaUsageBar(_props?: QuotaUsageBarProps) {
  return {
    percentage: 0,
    isWarning: false,
    isExceeded: false,
  };
}

export interface PricingPlan {
  id: string;
  name: string;
  description?: string;
  price?: number;
  features?: string[];
}

export interface PricingPlansProps {
  plans: PricingPlan[];
  currentPlanId?: string;
  onSelect?: (planId: string) => void;
}

export function createPricingPlans(_props?: PricingPlansProps) {
  return {
    plans: [] as PricingPlan[],
    selectedPlanId: null as string | null,
  };
}

export interface UsageAnalyticsData {
  storageUsed: number;
  storageLimit: number;
  uploadCount: number;
  downloadCount: number;
}

export interface UsageAnalyticsProps {
  data?: UsageAnalyticsData;
}

export function createUsageAnalytics(_props?: UsageAnalyticsProps) {
  return {
    data: null as UsageAnalyticsData | null,
  };
}

export {
  createFileDropzone as FileDropzone,
  createUploadProgressList as UploadProgressList,
  createFileList as FileList,
  createQuotaUsageBar as QuotaUsageBar,
  createPricingPlans as PricingPlans,
  createUsageAnalytics as UsageAnalytics,
};
