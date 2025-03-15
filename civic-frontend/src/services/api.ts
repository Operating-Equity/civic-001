import axios, { AxiosError, AxiosRequestConfig } from 'axios';
import {
  ClaimAnalysis,
  Claim,
  KeywordResult,
  ClaimSearchResults,
  VideoAnalysisResult,
  SearchResult
} from '../types';

// Create axios instance with base configuration and longer default timeout
const api = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json'
  },
  timeout: 60000, // Increased to 60 seconds default timeout for batch operations
});

// Configure axios to retry failed requests
api.interceptors.response.use(undefined, async (error) => {
  // Only retry on network errors or 5xx server errors
  const shouldRetry = 
    !error.response || 
    (error.response.status >= 500 && error.response.status < 600);

  // Get the original request config  
  const config = error.config as AxiosRequestConfig & { _retry?: boolean };
  
  // Only retry once
  if (shouldRetry && !config._retry) {
    config._retry = true;
    // Wait 2 seconds before retrying
    await new Promise(resolve => setTimeout(resolve, 2000));
    return api(config);
  }
  
  return Promise.reject(error);
});

// Process video from URL with expanded timeout and speaker identification
export const processVideoUrl = async (videoUrl: string, withSpeakers = false): Promise<VideoAnalysisResult> => {
  try {
    // First get transcript with longer timeout for video processing
    const transcriptResponse = await api.post('/video/process', { 
      video_url: videoUrl,
      with_speakers: withSpeakers 
    }, {
      timeout: 180000 // 3 minute timeout for video processing with speaker identification
    });
    
    const { 
      transcript, 
      video_title: videoTitle, 
      thumbnail_url: thumbnailUrl,
      speakers_data: speakersData 
    } = transcriptResponse.data;
    
    if (!transcript || !transcript.trim()) {
      throw new Error('No transcript could be extracted from this video.');
    }
    
    // Generate summary (separate try-catch to continue if this fails)
    let summary = '';
    try {
      const summaryResponse = await api.post('/analysis/summary', { 
        transcript,
        video_title: videoTitle 
      });
      summary = summaryResponse.data.summary;
    } catch (summaryError) {
      console.error('Error generating summary:', summaryError);
      summary = 'Summary generation failed. Please try again later.';
    }
    
    // Extract claims (separate try-catch to continue if this fails)
    let empiricalClaims: ClaimAnalysis[] = [];
    try {
      const claimsResponse = await api.post('/analysis/claims', { 
        transcript,
        video_title: videoTitle,
        speakers_data: speakersData
      });
      empiricalClaims = claimsResponse.data.claims || [];
    } catch (claimsError) {
      console.error('Error extracting claims:', claimsError);
    }
    
    return {
      transcript,
      summary,
      empiricalClaims,
      videoTitle,
      thumbnailUrl,
      speakers_data: speakersData
    };
  } catch (error) {
    console.error('Error processing video URL:', error);
    
    // Enhanced error handling for YouTube video processing
    const axiosError = error as AxiosError;
    
    if (axiosError.response) {
      // Server responded with an error status
      if (axiosError.response.status === 502) {
        throw new Error('Connection to video processing service timed out. The video may be too long or unavailable. Please try again with a shorter video.');
      } else if (axiosError.response.status === 500) {
        throw new Error('The server encountered an error while processing this video. The video may not have any captions available.');
      } else if (axiosError.response.data && typeof axiosError.response.data === 'object' && 'error' in axiosError.response.data) {
        // Access error message safely
        const errorData = axiosError.response.data as { error: string };
        throw new Error(`Video processing failed: ${errorData.error}`);
      } else {
        throw new Error(`Server error (${axiosError.response.status}): Unable to process YouTube video.`);
      }
    } else if (axiosError.code === 'ECONNABORTED') {
      // Request timed out
      throw new Error('The video is taking too long to process. Please try a shorter video or check your connection.');
    } else if (axiosError.request) {
      // Request was made but no response received
      throw new Error('Unable to connect to the server. Please check your internet connection and try again.');
    } else {
      // Something else caused the error
      throw new Error(axiosError.message || 'An unknown error occurred while processing the video.');
    }
  }
};

// Process video from file upload with speaker identification support
export const processVideoFile = async (file: File, withSpeakers = false): Promise<VideoAnalysisResult> => {
  try {
    const formData = new FormData();
    formData.append('video_file', file);
    
    // Add speaker identification flag
    if (withSpeakers) {
      formData.append('with_speakers', 'true');
    }
    
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
      timeout: 300000, // 5 minutes
      // Add progress tracking (could be used with a UI indicator)
      onUploadProgress: (progressEvent) => {
        const percentCompleted = Math.round((progressEvent.loaded * 100) / (progressEvent.total || file.size));
        console.log(`Upload Progress: ${percentCompleted}%`);
      }
    });
    
    const { 
      transcript, 
      video_title: videoTitle,
      speakers_data: speakersData 
    } = transcriptResponse.data;
    
    if (!transcript || !transcript.trim()) {
      throw new Error('No audio could be extracted from this video file.');
    }
    
    // Generate summary (separate try-catch to continue if this fails)
    let summary = '';
    try {
      const summaryResponse = await api.post('/analysis/summary', { 
        transcript,
        video_title: videoTitle 
      });
      summary = summaryResponse.data.summary;
    } catch (summaryError) {
      console.error('Error generating summary:', summaryError);
      summary = 'Summary generation failed. Please try again later.';
    }
    
    // Extract claims (separate try-catch to continue if this fails)
    let empiricalClaims: ClaimAnalysis[] = [];
    try {
      const claimsResponse = await api.post('/analysis/claims', { 
        transcript,
        video_title: videoTitle,
        speakers_data: speakersData
      });
      empiricalClaims = claimsResponse.data.claims || [];
    } catch (claimsError) {
      console.error('Error extracting claims:', claimsError);
    }
    
    return {
      transcript,
      summary,
      empiricalClaims,
      videoTitle,
      speakers_data: speakersData
    };
  } catch (error) {
    console.error('Error processing video file:', error);
    
    // Enhanced error handling for file upload errors
    const axiosError = error as AxiosError;
    
    if (axiosError.message === 'Video file exceeds the maximum size limit of 100MB.') {
      throw axiosError; // Custom error already formatted
    } else if (axiosError.response) {
      // Server responded with an error status
      if (axiosError.response.status === 413) {
        throw new Error('Video file too large. Please upload a file smaller than 100MB.');
      } else if (axiosError.response.status === 502 || axiosError.code === 'ECONNABORTED') {
        throw new Error('Video processing timed out. Please try a smaller file or a different format.');
      } else if (axiosError.response.data && typeof axiosError.response.data === 'object' && 'error' in axiosError.response.data) {
        // Access error message safely
        const errorData = axiosError.response.data as { error: string };
        throw new Error(`Video processing failed: ${errorData.error}`);
      } else {
        throw new Error(`Server error (${axiosError.response.status}): Unable to process video file.`);
      }
    } else if (axiosError.request) {
      // Request was made but no response received (likely timeout)
      throw new Error('Video upload timed out. Please try a smaller file or check your connection.');
    } else {
      // Something else caused the error
      throw new Error(axiosError.message || 'An unknown error occurred while processing the video.');
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
    }, {
      timeout: 45000 // 45 seconds for claim evaluation
    });
    return response.data;
  } catch (error) {
    console.error('Error evaluating claim:', error);
    throw error;
  }
};

// New method to evaluate multiple claims in parallel
export const evaluateMultipleClaims = async (
  claims: { id?: string; claim: string; context?: string }[],
  context: string = '',
  model: string = 'all'
): Promise<Record<string, { [model: string]: Claim }>> => {
  try {
    const response = await api.post('/analysis/evaluate', { 
      claims, 
      context,
      model
    }, {
      timeout: Math.max(60000, claims.length * 20000) // Base timeout + additional time per claim
    });
    return response.data;
  } catch (error) {
    console.error('Error evaluating multiple claims:', error);
    throw error;
  }
};

// Process and verify a video in one request
export const processAndVerifyVideo = async (
  input: { type: 'url' | 'file'; value: string | File; with_speakers?: boolean }
): Promise<VideoAnalysisResult> => {
  try {
    if (input.type === 'url') {
      const videoUrl = input.value as string;
      const response = await api.post('/video/process-and-verify', {
        video_url: videoUrl,
        with_speakers: input.with_speakers
      }, {
        timeout: 300000 // 5 minutes for complete processing
      });
      return response.data;
    } else {
      const file = input.value as File;
      const formData = new FormData();
      formData.append('video_file', file);
      
      if (input.with_speakers) {
        formData.append('with_speakers', 'true');
      }
      
      const response = await axios.post('/api/video/process-and-verify', formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        },
        timeout: 300000 // 5 minutes
      });
      return response.data;
    }
  } catch (error) {
    console.error('Error in process and verify:', error);
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

// Generate keywords for multiple claims in parallel
export const generateKeywordsBatch = async (
  claims: ClaimAnalysis[],
  videoTitle: string = ''
): Promise<KeywordResult[]> => {
  try {
    const response = await api.post('/search/keywords/batch', {
      claims,
      video_title: videoTitle
    });
    return response.data.results;
  } catch (error) {
    console.error('Error generating batch keywords:', error);
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

// Search for evidence across multiple queries in parallel
export const searchEvidenceBatch = async (queries: string[]): Promise<SearchResult[][]> => {
  try {
    const response = await api.post('/search/evidence/batch', { queries });
    return response.data.results;
  } catch (error) {
    console.error('Error in batch evidence search:', error);
    throw error;
  }
};

// Search for evidence for a specific claim
export const searchEvidenceForClaim = async (
  claim: ClaimAnalysis,
  videoTitle: string = ''
): Promise<ClaimSearchResults> => {
  try {
    const response = await api.post('/search/evidence/for-claim', {
      claim: claim.claim,
      context: claim.context,
      validation_potential: claim.validationPotential,
      video_title: videoTitle
    });
    return response.data;
  } catch (error) {
    console.error('Error searching evidence for claim:', error);
    throw error;
  }
};

// Search for evidence for multiple claims in parallel
export const searchEvidenceForClaims = async (
  claims: ClaimAnalysis[],
  videoTitle: string = ''
): Promise<ClaimSearchResults[]> => {
  try {
    const response = await api.post('/search/evidence/for-claims', {
      claims,
      video_title: videoTitle
    });
    return response.data.results;
  } catch (error) {
    console.error('Error searching evidence for multiple claims:', error);
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