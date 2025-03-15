"""
Schema definitions for data models used in the application.
These provide consistent structure for data passed between frontend and backend.
"""
from typing import List, Dict, Optional, Union, Any

# Claim Analysis Schemas
class EvidenceItem:
    """A single piece of evidence with source"""
    fact: str
    source: str

class DetailedAnalysis:
    """Detailed breakdown of claim analysis"""
    thinking: Optional[List[str]] = None
    definitions: Optional[List[str]] = None
    principles: Optional[List[str]] = None
    evidence: Optional[List[Dict[str, str]]] = None
    keyTerms: Optional[List[str]] = None
    logicalAnalysis: Optional[List[str]] = None
    evidenceAssessment: Optional[List[str]] = None
    analysis: Optional[str] = None
    conclusion: Optional[str] = None

class ClaimAnalysis:
    """Result of claim extraction process"""
    claim: str
    context: str
    validationPotential: str

class Claim:
    """Evaluated claim with classification"""
    statement: str
    classification: str  # 'TRUE', 'FALSE', or 'UNVERIFIED'
    supportingFacts: str
    confidence: float  # 0-100
    detailedAnalysis: Optional[DetailedAnalysis] = None
    model: Optional[str] = None

# Search Schemas
class SearchResult:
    """A single search result from Exa.ai"""
    title: str
    url: str
    publishedDate: str
    author: str
    score: float
    text: str
    summary: str

class KeywordResult:
    """Search keywords generated for a claim"""
    claim: str
    searchQueries: List[str]

class ClaimSearchResults:
    """Search results for a claim across multiple keywords"""
    claim: str
    keywordResults: List[Dict[str, Any]]  # Each has 'keyword' and 'results' fields

# Video Processing Schemas
class TranscriptResult:
    """Result of video transcript extraction"""
    transcript: str
    video_title: str
    thumbnail_url: Optional[str] = None

class VideoAnalysisResult:
    """Complete result of video analysis"""
    transcript: str
    summary: str
    empiricalClaims: List[ClaimAnalysis]
    video_title: str
    thumbnail_url: Optional[str] = None
