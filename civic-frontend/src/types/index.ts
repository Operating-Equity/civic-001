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

export interface ClaimAnalysis {
  claim: string;
  context: string;
  validationPotential: string;
}

export type ClassificationType = 'TRUE' | 'FALSE' | 'UNVERIFIED';

export interface Claim {
  statement: string;
  classification: ClassificationType;
  supportingFacts: string;
  confidence: number;
  detailedAnalysis?: DetailedAnalysis;
  model?: string;
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
}

export interface ModelComparisonItem {
  claim: string;
  results: {
    [model: string]: Claim;
  };
}