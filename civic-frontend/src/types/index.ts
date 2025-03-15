export interface EvidenceItem {
  fact: string;
  source: string;
}

export interface DetailedAnalysis {
  thinking?: string[];
  definitions?: string[];
  principles?: string[];
  evidence?: EvidenceItem[];
  keyTerms?: string[];
  logicalAnalysis?: string[];
  evidenceAssessment?: string[];
  analysis?: string;
  conclusion?: string;
}

export interface Speaker {
  id: string;
  name?: string;
}

export interface SpeakerSegment {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface SpeakersData {
  speakers: Record<string, string>;
  segments: SpeakerSegment[];
}

export interface ClaimAnalysis {
  id?: string;
  claim: string;
  context: string;
  validationPotential: string;
  speaker?: Speaker; // Added speaker information
}

export type ClassificationType = 'TRUE' | 'FALSE' | 'UNVERIFIED';

export interface Claim {
  statement: string;
  classification: ClassificationType;
  confidence: number;
  supportingFacts: string;
  model?: string;
  claimId?: string;
  error?: string;
  detailedAnalysis?: {
    definitions?: string[];
    principles?: string[];
    evidence?: EvidenceItem[];
    keyTerms?: string[];
    thinking?: string[];
    logicalAnalysis?: string[];
    evidenceAssessment?: string[];
    analysis?: string;
    conclusion?: string;
  };
}

export interface SearchResult {
  title: string;
  url: string;
  publishedDate: string;
  author: string;
  score: number;
  text: string;
  summary: string;
}

export interface KeywordResult {
  claim: string;
  searchQueries: string[];
}

export interface ClaimSearchResults {
  claim: string;
  keywordResults: {
    keyword: string;
    results: SearchResult[];
  }[];
}

export interface VideoAnalysisResult {
  transcript: string;
  summary: string;
  empiricalClaims: ClaimAnalysis[];
  videoTitle: string;
  thumbnailUrl?: string;
  speakers_data?: SpeakersData;
  verification_certificate?: VerificationCertificate;
}

export interface ModelComparisonItem {
  claim: string;
  results: {
    [model: string]: Claim;
  };
}

export type ServiceStatus = 'idle' | 'loading' | 'success' | 'error';

export interface ErrorMessages {
  perplexity?: string;
  openai?: string;
  anthropic?: string;
}

export interface ServiceStatuses {
  perplexity: ServiceStatus;
  openai: ServiceStatus;
  anthropic: ServiceStatus;
}

export interface VerificationCertificate {
  certificate_id: string;
  video_title: string;
  verification_date: string;
  claim_counts: {
    TRUE: number;
    FALSE: number;
    UNVERIFIED: number;
  };
  thumbnail_url?: string;
  verification_url: string;
}