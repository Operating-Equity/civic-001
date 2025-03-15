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
  } catch (error: any) {
    console.error('Error processing video URL:', error);
    
    // Enhanced error handling for YouTube video processing
    if (error.response) {
      // Server responded with an error status
      if (error.response.status === 502) {
        throw new Error('Connection to video processing service timed out. Please try again or use a shorter video.');
      } else if (error.response.data && error.response.data.error) {
        throw new Error(`Video processing failed: ${error.response.data.error}`);
      } else {
        throw new Error(`Server error (${error.response.status}): Unable to process YouTube video.`);
      }
    } else if (error.request) {
      // Request was made but no response received
      throw new Error('Unable to connect to the server. Please check your internet connection and try again.');
    } else {
      // Something else caused the error
      throw new Error(error.message || 'An unknown error occurred while processing the video.');
    }
  }
};

// Process video from file upload
export const processVideoFile = async (file: File): Promise<VideoAnalysisResult> => {
  try {
    const formData = new FormData();
    formData.append('video_file', file);
    
    // Check file size before uploading - prevent 413 errors
    if (file.size > 100 * 1024 * 1024) { // 100MB
      throw new Error('Video file exceeds the maximum size limit of 100MB.');
    }
    
    // Need to update headers for form data
    const transcriptResponse = await axios.post('/api/video/process', formData, {
      headers: {
        'Content-Type': 'multipart/form-data'
      },
      // Increase timeout for large file uploads
      timeout: 300000 // 5 minutes
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
  } catch (error: any) {
    console.error('Error processing video file:', error);
    
    // Enhanced error handling for file upload errors
    if (error.message === 'Video file exceeds the maximum size limit of 100MB.') {
      throw error; // Custom error already formatted
    } else if (error.response) {
      // Server responded with an error status
      if (error.response.status === 413) {
        throw new Error('Video file too large. Please upload a file smaller than 100MB.');
      } else if (error.response.data && error.response.data.error) {
        throw new Error(`Video processing failed: ${error.response.data.error}`);
      } else {
        throw new Error(`Server error (${error.response.status}): Unable to process video file.`);
      }
    } else if (error.request) {
      // Request was made but no response received (likely timeout)
      throw new Error('Video upload timed out. Please try a smaller file or check your connection.');
    } else {
      // Something else caused the error
      throw new Error(error.message || 'An unknown error occurred while processing the video.');
    }
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