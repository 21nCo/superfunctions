import { describe, it, expect } from 'vitest';
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
