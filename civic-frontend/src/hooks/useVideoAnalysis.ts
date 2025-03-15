import { useState, useCallback } from 'react';
import { 
  ClaimAnalysis, 
  Claim,
  VideoAnalysisResult
} from '../types';
import { 
  processVideoUrl, 
  processVideoFile,
  evaluateClaim 
} from '../services/api';

export const useVideoAnalysis = () => {
  const [transcript, setTranscript] = useState('');
  const [thumbnailUrl, setThumbnailUrl] = useState('');
  const [summary, setSummary] = useState('');
  const [videoTitle, setVideoTitle] = useState('');
  
  const [empiricalClaims, setEmpiricalClaims] = useState<ClaimAnalysis[]>([]);
  const [perplexityResults, setPerplexityResults] = useState<Claim[]>([]);
  const [openAIResults, setOpenAIResults] = useState<Claim[]>([]);
  const [anthropicResults, setAnthropicResults] = useState<Claim[]>([]);
  
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const resetStates = useCallback(() => {
    setTranscript('');
    setThumbnailUrl('');
    setSummary('');
    setVideoTitle('');
    setEmpiricalClaims([]);
    setPerplexityResults([]);
    setOpenAIResults([]);
    setAnthropicResults([]);
    setError(null);
  }, []);
  
  const handleVideoSubmit = useCallback(async (input: { type: 'file' | 'url'; value: File | string; model?: string }) => {
    setIsLoading(true);
    setError(null);
    resetStates();
    
    try {
      let result: VideoAnalysisResult;
      
      if (input.type === 'url') {
        result = await processVideoUrl(input.value as string);
      } else {
        result = await processVideoFile(input.value as File);
      }
      
      // Set the basic video analysis results
      setTranscript(result.transcript);
      setSummary(result.summary);
      setEmpiricalClaims(result.empiricalClaims);
      setVideoTitle(result.videoTitle);
      
      if (result.thumbnailUrl) {
        setThumbnailUrl(result.thumbnailUrl);
      }
      
      // Process each claim with AI models
      processClaims(result.empiricalClaims, result.summary);
      
    } catch (error: any) {
      setError(error.message || 'Failed to process video');
      console.error('Error processing video:', error);
    } finally {
      setIsLoading(false);
    }
  }, [resetStates]);
  
  const processClaims = useCallback(async (claims: ClaimAnalysis[], summary: string) => {
    if (!claims.length) return;
    
    // Process claims one by one to avoid rate limits
    for (let i = 0; i < claims.length; i++) {
      const claim = claims[i];
      
      try {
        // Create context including summary and specific claim context
        const context = `
Video Summary:
${summary}

Claim Context:
${claim.context}

Validation Approach:
${claim.validationPotential}
        `;
        
        // Evaluate claim with all models
        const results = await evaluateClaim(claim.claim, context);
        
        // Update results for each model
        if (results.perplexity) {
          setPerplexityResults(prev => [...prev, results.perplexity]);
        }
        
        if (results.openai) {
          setOpenAIResults(prev => [...prev, results.openai]);
        }
        
        if (results.anthropic) {
          setAnthropicResults(prev => [...prev, results.anthropic]);
        }
      } catch (error) {
        console.error(`Error processing claim ${i + 1}:`, error);
      }
    }
  }, []);
  
  return {
    // State
    transcript,
    thumbnailUrl,
    summary,
    videoTitle,
    empiricalClaims,
    perplexityResults,
    openAIResults,
    anthropicResults,
    isLoading,
    error,
    
    // Actions
    handleVideoSubmit,
    resetStates
  };
};