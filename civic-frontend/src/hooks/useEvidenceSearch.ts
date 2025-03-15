import { useState, useCallback, useEffect } from 'react';
import { ClaimAnalysis, KeywordResult, ClaimSearchResults, SearchResult } from '../types';
import { generateKeywords, searchEvidence } from '../services/api';

export const useEvidenceSearch = (
  claims: ClaimAnalysis[],
  videoTitle?: string
) => {
  const [keywordResults, setKeywordResults] = useState<KeywordResult[]>([]);
  const [searchResults, setSearchResults] = useState<ClaimSearchResults[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Generate keywords for claims
  const generateKeywordsForClaims = useCallback(async () => {
    if (!claims.length) return;
    
    setIsGenerating(true);
    setError(null);
    
    try {
      const results: KeywordResult[] = [];
      
      for (const claim of claims) {
        try {
          const searchQueries = await generateKeywords(
            claim.claim,
            claim.context,
            claim.validationPotential,
            videoTitle || ''
          );
          
          results.push({
            claim: claim.claim,
            searchQueries
          });
        } catch (error) {
          console.error('Error generating keywords for claim:', claim.claim, error);
        }
      }
      
      setKeywordResults(results);
    } catch (error: any) {
      setError(error.message || 'Failed to generate keywords');
      console.error('Error generating keywords:', error);
    } finally {
      setIsGenerating(false);
    }
  }, [claims, videoTitle]);
  
  // Effect to generate keywords when claims change
  useEffect(() => {
    if (claims.length > 0) {
      generateKeywordsForClaims();
    }
  }, [claims, generateKeywordsForClaims]);
  
  // Search for evidence using generated keywords
  const searchForEvidence = useCallback(async (claim: string, keywords: string[]) => {
    if (!keywords.length) return;
    
    setIsSearching(true);
    setError(null);
    
    try {
      const keywordResults: { keyword: string; results: SearchResult[] }[] = [];
      
      for (const keyword of keywords) {
        try {
          const results = await searchEvidence(keyword);
          keywordResults.push({
            keyword,
            results
          });
        } catch (error) {
          console.error('Error searching for keyword:', keyword, error);
        }
      }
      
      // Check if we already have search results for this claim
      const existingResultIndex = searchResults.findIndex(r => r.claim === claim);
      
      if (existingResultIndex >= 0) {
        // Update existing results
        const updatedResults = [...searchResults];
        updatedResults[existingResultIndex] = {
          claim,
          keywordResults
        };
        setSearchResults(updatedResults);
      } else {
        // Add new results
        setSearchResults(prev => [
          ...prev,
          {
            claim,
            keywordResults
          }
        ]);
      }
      
      // Scroll to the evidence section when results are loaded
      setTimeout(() => {
        const evidenceSection = document.getElementById('evidence-section');
        if (evidenceSection) {
          evidenceSection.scrollIntoView({ behavior: 'smooth' });
        }
      }, 100);
      
    } catch (error: any) {
      setError(error.message || 'Failed to search for evidence');
      console.error('Error searching for evidence:', error);
    } finally {
      setIsSearching(false);
    }
  }, [searchResults]);
  
  // Search all claims with their keywords
  const searchAllClaims = useCallback(async () => {
    if (!keywordResults.length) return;
    
    setIsSearching(true);
    setError(null);
    
    try {
      for (const keywordResult of keywordResults) {
        await searchForEvidence(keywordResult.claim, keywordResult.searchQueries);
      }
    } catch (error: any) {
      setError(error.message || 'Failed to search all claims');
      console.error('Error searching all claims:', error);
    } finally {
      setIsSearching(false);
    }
  }, [keywordResults, searchForEvidence]);
  
  return {
    keywordResults,
    searchResults,
    isGenerating,
    isSearching,
    error,
    generateKeywordsForClaims,
    searchForEvidence,
    searchAllClaims
  };
};