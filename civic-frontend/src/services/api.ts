import axios from 'axios';
import {
  ClaimAnalysis,
  Claim,
  KeywordResult,
  ClaimSearchResults,
  VideoAnalysisResult,
  SearchResult
} from '../types';

// Create axios instance with base configuration
const api = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json'
  }
});

// Process video from URL
export const processVideoUrl = async (videoUrl: string): Promise<VideoAnalysisResult> => {
  try {
    // First get transcript
    const transcriptResponse = await api.post('/video/process', { video_url: videoUrl });
    const { transcript, video_title: videoTitle, thumbnail_url: thumbnailUrl } = transcriptResponse.data;
    
    // Generate summary
    const summaryResponse = await api.post('/analysis/summary', { transcript });
    const { summary } = summaryResponse.data;
    
    // Extract claims
    const claimsResponse = await api.post('/analysis/claims', { transcript });
    const { claims: empiricalClaims } = claimsResponse.data;
    
    return {
      transcript,
      summary,
      empiricalClaims,
      videoTitle,
      thumbnailUrl
    };
  } catch (error) {
    console.error('Error processing video URL:', error);
    throw error;
  }
};

// Process video from file upload
export const processVideoFile = async (file: File): Promise<VideoAnalysisResult> => {
  try {
    const formData = new FormData();
    formData.append('video_file', file);
    
    // Need to update headers for form data
    const transcriptResponse = await axios.post('/api/video/process', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      }
    });
    
    const { transcript, video_title: videoTitle } = transcriptResponse.data;
    
    // Generate summary
    const summaryResponse = await api.post('/analysis/summary', { transcript });
    const { summary } = summaryResponse.data;
    
    // Extract claims
    const claimsResponse = await api.post('/analysis/claims', { transcript });
    const { claims: empiricalClaims } = claimsResponse.data;
    
    return {
      transcript,
      summary,
      empiricalClaims,
      videoTitle
    };
  } catch (error) {
    console.error('Error processing video file:', error);
    throw error;
  }
};

// Evaluate a claim across all models
export const evaluateClaim = async (
  claim: string,
  context: string = '',
  model: string = 'all'
): Promise<{ [model: string]: Claim }> => {
  try {
    const response = await api.post('/analysis/evaluate', { 
      claim, 
      context,
      model
    });
    return response.data;
  } catch (error) {
    console.error('Error evaluating claim:', error);
    throw error;
  }
};

// Generate search keywords for a claim
export const generateKeywords = async (
  claim: string,
  context: string = '',
  validationPotential: string = '',
  videoTitle: string = ''
): Promise<string[]> => {
  try {
    const response = await api.post('/search/keywords', {
      claim,
      context,
      validation_potential: validationPotential,
      video_title: videoTitle
    });
    return response.data.keywords;
  } catch (error) {
    console.error('Error generating keywords:', error);
    throw error;
  }
};

// Search for evidence
export const searchEvidence = async (query: string): Promise<SearchResult[]> => {
  try {
    const response = await api.post('/search/evidence', { query });
    return response.data.results;
  } catch (error) {
    console.error('Error searching for evidence:', error);
    throw error;
  }
};

// Health check
export const healthCheck = async (): Promise<{ status: string; version: string }> => {
  try {
    const response = await api.get('/health');
    return response.data;
  } catch (error) {
    console.error('Health check failed:', error);
    throw error;
  }
};