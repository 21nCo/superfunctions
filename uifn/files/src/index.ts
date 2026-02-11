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

export function createFileDropzone(props?: FileDropzoneProps) {
  const state: FileDropzoneState = { isDragging: false, files: [] };

  const handleFiles = (files: File[]) => {
    if (props?.disabled) return;

    const filteredFiles = props?.accept
      ? files.filter((file) => {
          const fileExt = file.name.split('.').pop()?.toLowerCase();
          const mimeType = file.type;
          return props.accept?.some((accept) => {
            if (accept.startsWith('.')) {
              return `.${fileExt}` === accept.toLowerCase();
            }
            if (accept.includes('*')) {
              const pattern = accept.replace('*', '.*');
              return new RegExp(`^${pattern}$`).test(mimeType);
            }
            return mimeType === accept;
          });
        })
      : files;

    const finalFiles = props?.multiple ? filteredFiles : filteredFiles.slice(0, 1);

    state.files = finalFiles;
    props?.onFiles?.(finalFiles);
  };

  return {
    state,
    onDragOver: (e: DragEvent) => {
      if (props?.disabled) return;
      e.preventDefault();
      state.isDragging = true;
    },
    onDragLeave: (e: DragEvent) => {
      if (props?.disabled) return;
      e.preventDefault();
      state.isDragging = false;
    },
    onDrop: (e: DragEvent) => {
      if (props?.disabled) return;
      e.preventDefault();
      state.isDragging = false;

      const files = Array.from(e.dataTransfer?.files || []);
      handleFiles(files);
    },
    onInputChange: (e: Event) => {
      if (props?.disabled) return;
      const input = e.target as HTMLInputElement;
      const files = Array.from(input.files || []);
      handleFiles(files);
    },
  };
}

export interface UploadProgressItem {
  id: string;
  fileName: string;
  bytesUploaded: number;
  bytesTotal: number;
  status: 'pending' | 'uploading' | 'completed' | 'error';
  error?: string;
  errorCode?: string;
}

export interface UploadProgressListProps {
  items: UploadProgressItem[];
  onCancel?: (id: string) => void;
  onRetry?: (id: string) => void;
}

export function createUploadProgressList(props?: UploadProgressListProps) {
  return {
    items: props?.items || [],
    getProgress: (item: UploadProgressItem) => {
      if (item.bytesTotal === 0) return 0;
      return Math.round((item.bytesUploaded / item.bytesTotal) * 100);
    },
    canCancel: (item: UploadProgressItem) => {
      return item.status === 'pending' || item.status === 'uploading';
    },
    canRetry: (item: UploadProgressItem) => {
      return item.status === 'error';
    },
    onCancel: (id: string) => {
      const item = props?.items.find((i) => i.id === id);
      if (item && (item.status === 'pending' || item.status === 'uploading')) {
        props?.onCancel?.(id);
      }
    },
    onRetry: (id: string) => {
      const item = props?.items.find((i) => i.id === id);
      if (item && item.status === 'error') {
        props?.onRetry?.(id);
      }
    },
    hasError: (item: UploadProgressItem) => item.status === 'error',
    getErrorDisplay: (item: UploadProgressItem) => {
      if (item.status !== 'error') return null;
      return {
        errorCode: item.errorCode,
        error: item.error,
        shown: true,
      };
    },
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

export interface FileListState {
  files: FileListItem[];
  selectedFileId: string | null;
}

export function createFileList(props?: FileListProps) {
  const state: FileListState = {
    files: props?.files || [],
    selectedFileId: null,
  };

  return {
    state,
    selectFile: (file: FileListItem) => {
      state.selectedFileId = file.id;
      props?.onSelect?.(file);
    },
    deleteFile: (file: FileListItem) => {
      props?.onDelete?.(file);
    },
    getFile: (id: string) => {
      return state.files.find((f) => f.id === id);
    },
    sortBy: (key: keyof FileListItem, order: 'asc' | 'desc' = 'asc') => {
      const sorted = [...state.files].sort((a, b) => {
        const aVal = a[key];
        const bVal = b[key];
        if (aVal < bVal) return order === 'asc' ? -1 : 1;
        if (aVal > bVal) return order === 'asc' ? 1 : -1;
        return 0;
      });
      state.files = sorted;
      return sorted;
    },
    formatSize: (bytes: number) => {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
    },
  };
}

export interface QuotaUsageBarProps {
  used: number;
  limit: number;
  warningThreshold?: number;
}

export interface QuotaUsageBarState {
  percentage: number;
  isWarning: boolean;
  isExceeded: boolean;
  used: number;
  limit: number;
  available: number;
}

export function createQuotaUsageBar(props?: QuotaUsageBarProps) {
  const used = props?.used || 0;
  const limit = props?.limit || 0;
  const warningThreshold = props?.warningThreshold || 0.8;

  const percentage = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  const isWarning = percentage >= warningThreshold * 100 && percentage < 100;
  const isExceeded = used >= limit;
  const available = Math.max(limit - used, 0);

  return {
    state: {
      percentage,
      isWarning,
      isExceeded,
      used,
      limit,
      available,
    },
    getUsageLevel: () => {
      if (isExceeded) return 'exceeded';
      if (isWarning) return 'warning';
      return 'normal';
    },
    formatBytes: (bytes: number) => {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
    },
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

export interface PricingPlansState {
  plans: PricingPlan[];
  selectedPlanId: string | null;
  error?: string;
}

export function createPricingPlans(props?: PricingPlansProps) {
  const state: PricingPlansState = {
    plans: props?.plans || [],
    selectedPlanId: props?.currentPlanId || null,
  };

  return {
    state,
    getPlan: (planId: string) => {
      return state.plans.find((p) => p.id === planId);
    },
    isValidPlan: (planId: string) => {
      return state.plans.some((p) => p.id === planId);
    },
    selectPlan: (planId: string) => {
      if (!state.plans.some((p) => p.id === planId)) {
        state.error = 'invalid_plan';
        return false;
      }
      state.selectedPlanId = planId;
      state.error = undefined;
      props?.onSelect?.(planId);
      return true;
    },
    getCurrentPlan: () => {
      if (!state.selectedPlanId) return null;
      return state.plans.find((p) => p.id === state.selectedPlanId) || null;
    },
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

export interface UsageAnalyticsState {
  data: UsageAnalyticsData | null;
  storagePercentage: number;
  isStorageWarning: boolean;
}

export function createUsageAnalytics(props?: UsageAnalyticsProps) {
  const data = props?.data || null;
  const storagePercentage =
    data && data.storageLimit > 0
      ? Math.min((data.storageUsed / data.storageLimit) * 100, 100)
      : 0;
  const isStorageWarning = storagePercentage >= 80;

  return {
    state: {
      data,
      storagePercentage,
      isStorageWarning,
    },
    getStorageUsageText: () => {
      if (!data) return 'No data';
      const formatBytes = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
      };
      return `${formatBytes(data.storageUsed)} / ${formatBytes(data.storageLimit)}`;
    },
    getTotalActivity: () => {
      if (!data) return 0;
      return data.uploadCount + data.downloadCount;
    },
    getBreakdown: () => {
      if (!data) return { uploads: 0, downloads: 0 };
      return {
        uploads: data.uploadCount,
        downloads: data.downloadCount,
      };
    },
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
