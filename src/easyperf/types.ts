import type { VirtualizationTemplate } from '../virtualization/virtualization-template.js';

export interface EasyPerfConfig {
  baseUrl: string;
  username?: string;
  password?: string;
  project: string;
  squad: string;
  manualLogin: boolean;
}
export interface VirtualizationFile {
  filePath: string;
  fileName: string;
  application: string;
  flow: string;
  flowDirectory: string;
  reviewRequired: boolean;
}
export interface SelectedVirtualization extends VirtualizationFile {
  template: VirtualizationTemplate;
}
export interface PublishedService { method: string; path: string; url: string }
export interface PublicationResult { baseUrl: string; services: PublishedService[] }
export interface Publication extends PublicationResult { application: string; flow: string; publishedAt: string }
