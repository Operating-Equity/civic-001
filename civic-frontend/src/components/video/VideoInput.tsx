import React, { useState, useRef } from 'react';
import { AlertCircle, Upload, Link2, X, Users, Info, Cog, Youtube } from 'lucide-react';
import { ProcessingStage } from '../../hooks/useVideoAnalysis'; // Import the new type

interface VideoInputProps {
  onVideoSubmit: (input: { type: 'file' | 'url'; value: File | string; with_speakers?: boolean }) => void;
  isProcessing?: boolean;
  error?: string | null;
  processingStage?: ProcessingStage; // Add new prop
}

const VideoInput: React.FC<VideoInputProps> = ({ 
  onVideoSubmit, 
  isProcessing = false, 
  error = null,
  processingStage = 'idle' // Default to idle
}) => {
  const [inputType, setInputType] = useState<'file' | 'url'>('url');
  const [videoUrl, setVideoUrl] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [withSpeakers, setWithSpeakers] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Extract YouTube video ID for thumbnail preview
  const extractYouTubeId = (url: string) => {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
  };
  
  // Get YouTube thumbnail URL
  const getYouTubeThumbnail = (url: string) => {
    const videoId = extractYouTubeId(url);
    return videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : null;
  };
  
  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (videoUrl.trim() && !isProcessing) {
      onVideoSubmit({ 
        type: 'url', 
        value: videoUrl.trim(),
        with_speakers: withSpeakers
      });
    }
  };
  
  const handleFileSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedFile && !isProcessing) {
      onVideoSubmit({ 
        type: 'file', 
        value: selectedFile,
        with_speakers: withSpeakers
      });
    }
  };
  
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFile(e.target.files[0]);
    }
  };
  
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  
  const handleDragLeave = () => {
    setIsDragging(false);
  };
  
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setSelectedFile(e.dataTransfer.files[0]);
      setInputType('file');
    }
  };
  
  const clearFile = () => {
    setSelectedFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };
  
  // YouTube thumbnail preview
  const thumbnailUrl = videoUrl ? getYouTubeThumbnail(videoUrl) : null;
  
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-6">
      {/* Input Type Selector - Light Theme */}
      <div className="flex mb-6 bg-gray-100 rounded-full p-1 w-fit mx-auto">
        <button
          onClick={() => setInputType('url')}
          className={`px-5 py-2 rounded-full text-sm font-medium transition-colors flex items-center ${
            inputType === 'url' 
              ? 'bg-blue-600 text-white shadow-sm' 
              : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'
          }`}
        >
          <Youtube className="h-4 w-4 inline-block mr-2" />
          YouTube URL
        </button>
        <button
          onClick={() => setInputType('file')}
          className={`px-5 py-2 rounded-full text-sm font-medium transition-colors flex items-center ${
            inputType === 'file' 
              ? 'bg-blue-600 text-white shadow-sm' 
              : 'text-gray-600 hover:text-gray-900 hover:bg-gray-200'
          }`}
        >
          <Upload className="h-4 w-4 inline-block mr-2" />
          Upload Video
        </button>
      </div>
      
      {/* Error Message - Light Theme */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <div className="flex items-start">
            <AlertCircle className="h-5 w-5 text-red-500 mt-0.5 mr-2 flex-shrink-0" />
            <p className="text-red-600 text-sm">{error}</p>
          </div>
        </div>
      )}
      
      {/* URL Input - Light Theme */}
      {inputType === 'url' && (
        <form onSubmit={handleUrlSubmit} className="space-y-4">
          <div>
            <div className="bg-white border border-gray-300 focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500 transition-colors rounded-lg overflow-hidden">
              <input
                type="text"
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
                placeholder="Paste YouTube URL here (e.g., https://www.youtube.com/watch?v=...)"
                className="w-full px-4 py-3 bg-transparent text-gray-900 placeholder:text-gray-400 focus:outline-none"
                disabled={isProcessing}
              />
            </div>
          </div>
          
          {/* YouTube thumbnail preview */}
          {thumbnailUrl && !isProcessing && (
            <div className="mt-2 mb-4">
              <div className="relative w-full max-w-md mx-auto rounded-lg overflow-hidden border border-gray-200">
                <img 
                  src={thumbnailUrl} 
                  alt="Video thumbnail" 
                  className="w-full h-auto"
                  onError={(e) => {
                    // Hide thumbnail container if image fails to load
                    (e.target as HTMLElement).parentElement?.classList.add('hidden');
                  }}
                />
                <div className="absolute inset-0 bg-black bg-opacity-20 flex items-center justify-center">
                  <div className="flex items-center justify-center rounded-full bg-white bg-opacity-80 w-12 h-12">
                    <Youtube className="h-6 w-6 text-red-600" />
                  </div>
                </div>
              </div>
            </div>
          )}
          
          {/* Advanced Options Toggle */}
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center text-gray-600 hover:text-gray-800 text-sm"
            >
              <Cog className="h-4 w-4 mr-1.5" />
              {showAdvanced ? 'Hide Advanced Options' : 'Show Advanced Options'}
            </button>
          </div>
          
          {/* Advanced Options */}
          {showAdvanced && (
            <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center">
                  <Users className="h-4 w-4 text-gray-600 mr-2" />
                  <label htmlFor="with-speakers" className="text-sm font-medium text-gray-700">
                    Speaker Identification
                  </label>
                </div>
                <div>
                  <button
                    type="button"
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 ${
                      withSpeakers ? 'bg-blue-600' : 'bg-gray-200'
                    }`}
                    onClick={() => setWithSpeakers(!withSpeakers)}
                    id="with-speakers"
                    role="switch"
                    aria-checked={withSpeakers}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        withSpeakers ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              </div>
              <p className="text-xs text-gray-500 ml-6">
                Identify individual speakers in the video. May increase processing time.
              </p>
            </div>
          )}
          
          <div className="flex justify-center">
            <button 
              type="submit" 
              disabled={!videoUrl.trim() || isProcessing}
              className="px-6 py-3 font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center min-w-[180px] bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white shadow-sm"
            >
              {isProcessing ? (
                <>
                  <div className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin mr-2"></div>
                  <span>Analyzing...</span>
                </>
              ) : (
                <span>Verify Video</span>
              )}
            </button>
          </div>
        </form>
      )}
      
      {/* File Upload - Light Theme */}
      {inputType === 'file' && (
        <form onSubmit={handleFileSubmit} className="space-y-4">
          <div
            className={`
              border-2 border-dashed rounded-lg p-6
              ${isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-gray-50'}
              ${selectedFile ? 'border-blue-500/40 bg-blue-50/40' : ''}
              transition-colors duration-200
            `}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {selectedFile ? (
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-gray-800 font-medium">{selectedFile.name}</p>
                  <p className="text-gray-500 text-sm">
                    {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB
                  </p>
                </div>
                <button
                  type="button"
                  onClick={clearFile}
                  className="text-gray-500 hover:text-gray-700 p-1 rounded-full hover:bg-gray-200"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            ) : (
              <div className="text-center">
                <Upload className="h-10 w-10 text-blue-400 mx-auto mb-3" />
                <p className="text-gray-800 mb-2">Drop your video file here</p>
                <p className="text-gray-500 text-sm mb-4">Or select a file from your computer</p>
                <label
                  htmlFor="fileInput"
                  className="inline-block px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-800 rounded-lg cursor-pointer transition-colors"
                >
                  Browse Files
                </label>
                <input
                  id="fileInput"
                  ref={fileInputRef}
                  type="file"
                  accept="video/*"
                  onChange={handleFileSelect}
                  className="hidden"
                  disabled={isProcessing}
                />
              </div>
            )}
          </div>
          
          {/* Advanced Options Toggle */}
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center text-gray-600 hover:text-gray-800 text-sm"
            >
              <Cog className="h-4 w-4 mr-1.5" />
              {showAdvanced ? 'Hide Advanced Options' : 'Show Advanced Options'}
            </button>
          </div>
          
          {/* Advanced Options */}
          {showAdvanced && (
            <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center">
                  <Users className="h-4 w-4 text-gray-600 mr-2" />
                  <label htmlFor="with-speakers-file" className="text-sm font-medium text-gray-700">
                    Speaker Identification
                  </label>
                </div>
                <div>
                  <button
                    type="button"
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 ${
                      withSpeakers ? 'bg-blue-600' : 'bg-gray-200'
                    }`}
                    onClick={() => setWithSpeakers(!withSpeakers)}
                    id="with-speakers-file"
                    role="switch"
                    aria-checked={withSpeakers}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        withSpeakers ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              </div>
              <p className="text-xs text-gray-500 ml-6">
                Identify individual speakers in the video. May increase processing time.
              </p>
            </div>
          )}
          
          <div className="flex justify-center">
            <button 
              type="submit" 
              disabled={!selectedFile || isProcessing}
              className="px-6 py-3 font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center min-w-[180px] bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white shadow-sm"
            >
              {isProcessing ? (
                <>
                  <div className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin mr-2"></div>
                  <span>Analyzing...</span>
                </>
              ) : (
                <span>Verify Video</span>
              )}
            </button>
          </div>
        </form>
      )}
      
      {/* Processing Status with Dynamic Updates - Light Theme */}
      {isProcessing && (
        <div className="mt-6 pt-6 border-t border-gray-200">
          <div className="flex items-center space-x-3">
            <div className="h-4 w-4 rounded-full border-2 border-blue-600 border-t-transparent animate-spin"></div>
            <p className="text-gray-800 font-medium">Processing video</p>
          </div>
          <div className="mt-4 space-y-2">
            {/* Step 1: Transcript Extraction - always appears */}
            <div className="flex items-center">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center mr-3
                ${processingStage === 'extracting_transcript' 
                  ? 'bg-blue-100 text-blue-600' 
                  : processingStage === 'idle' ? 'bg-gray-100 text-gray-600' : 'bg-green-100 text-green-600'}`}>
                {processingStage === 'extracting_transcript' ? (
                  <span className="text-xs font-medium">1</span>
                ) : processingStage === 'idle' ? (
                  <span className="text-xs font-medium">1</span>
                ) : (
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M5 12L10 17L20 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </div>
              <div className="flex-1">
                <div className="flex justify-between text-sm">
                  <span className={processingStage === 'extracting_transcript' 
                    ? 'text-gray-800 font-medium' 
                    : processingStage === 'idle' ? 'text-gray-600' : 'text-green-600 font-medium'}>
                    Extracting audio and transcript
                  </span>
                  <span className={processingStage === 'extracting_transcript' 
                    ? 'text-blue-600 font-medium' 
                    : processingStage === 'idle' ? 'text-gray-600' : 'text-green-600 font-medium'}>
                    {processingStage === 'extracting_transcript' ? 'In Progress' : processingStage === 'idle' ? 'Waiting' : 'Complete'}
                  </span>
                </div>
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden mt-1">
                  <div 
                    className={`h-full rounded-full ${
                      processingStage === 'extracting_transcript' 
                        ? 'bg-blue-600 animate-pulse w-3/4' 
                        : processingStage === 'idle' ? 'bg-gray-400 w-0' : 'bg-green-600 w-full'
                    }`}>
                  </div>
                </div>
              </div>
            </div>
            
            {/* Step 2: Speaker Identification - only appears if needed */}
            {withSpeakers && (
              <div className="flex items-center">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center mr-3
                  ${processingStage === 'identifying_speakers' 
                    ? 'bg-blue-100 text-blue-600' 
                    : processingStage === 'idle' || processingStage === 'extracting_transcript' 
                      ? 'bg-gray-100 text-gray-600' 
                      : 'bg-green-100 text-green-600'}`}>
                  {processingStage === 'identifying_speakers' ? (
                    <span className="text-xs font-medium">2</span>
                  ) : processingStage === 'idle' || processingStage === 'extracting_transcript' ? (
                    <span className="text-xs font-medium">2</span>
                  ) : (
                    <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M5 12L10 17L20 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>
                <div className="flex-1">
                  <div className="flex justify-between text-sm">
                    <span className={processingStage === 'identifying_speakers' 
                      ? 'text-gray-800 font-medium' 
                      : processingStage === 'idle' || processingStage === 'extracting_transcript' 
                        ? 'text-gray-600' 
                        : 'text-green-600 font-medium'}>
                      Identifying Speakers
                    </span>
                    <span className={processingStage === 'identifying_speakers' 
                      ? 'text-blue-600 font-medium' 
                      : processingStage === 'idle' || processingStage === 'extracting_transcript' 
                        ? 'text-gray-600' 
                        : 'text-green-600 font-medium'}>
                      {processingStage === 'identifying_speakers' 
                        ? 'In Progress' 
                        : processingStage === 'idle' || processingStage === 'extracting_transcript' 
                          ? 'Waiting' 
                          : 'Complete'}
                    </span>
                  </div>
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden mt-1">
                    <div 
                      className={`h-full rounded-full ${
                        processingStage === 'identifying_speakers' 
                          ? 'bg-blue-600 animate-pulse w-3/4' 
                          : processingStage === 'idle' || processingStage === 'extracting_transcript' 
                            ? 'bg-gray-400 w-0' 
                            : 'bg-green-600 w-full'
                      }`}>
                    </div>
                  </div>
                </div>
              </div>
            )}
            
            {/* Step 3: Extracting Claims */}
            <div className="flex items-center">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center mr-3
                ${processingStage === 'extracting_claims' 
                  ? 'bg-blue-100 text-blue-600' 
                  : processingStage === 'idle' || 
                    processingStage === 'extracting_transcript' || 
                    processingStage === 'identifying_speakers' 
                    ? 'bg-gray-100 text-gray-600' 
                    : 'bg-green-100 text-green-600'}`}>
                {processingStage === 'extracting_claims' ? (
                  <span className="text-xs font-medium">{withSpeakers ? '3' : '2'}</span>
                ) : processingStage === 'idle' || 
                    processingStage === 'extracting_transcript' || 
                    processingStage === 'identifying_speakers' ? (
                  <span className="text-xs font-medium">{withSpeakers ? '3' : '2'}</span>
                ) : (
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M5 12L10 17L20 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </div>
              <div className="flex-1">
                <div className="flex justify-between text-sm">
                  <span className={processingStage === 'extracting_claims' 
                    ? 'text-gray-800 font-medium' 
                    : processingStage === 'idle' || 
                      processingStage === 'extracting_transcript' || 
                      processingStage === 'identifying_speakers' 
                      ? 'text-gray-600' 
                      : 'text-green-600 font-medium'}>
                    Extracting Empirical Claims
                  </span>
                  <span className={processingStage === 'extracting_claims' 
                    ? 'text-blue-600 font-medium' 
                    : processingStage === 'idle' || 
                      processingStage === 'extracting_transcript' || 
                      processingStage === 'identifying_speakers' 
                      ? 'text-gray-600' 
                      : 'text-green-600 font-medium'}>
                    {processingStage === 'extracting_claims' 
                      ? 'In Progress' 
                      : processingStage === 'idle' || 
                        processingStage === 'extracting_transcript' || 
                        processingStage === 'identifying_speakers' 
                        ? 'Waiting' 
                        : 'Complete'}
                  </span>
                </div>
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden mt-1">
                  <div 
                    className={`h-full rounded-full ${
                      processingStage === 'extracting_claims' 
                        ? 'bg-blue-600 animate-pulse w-3/4' 
                        : processingStage === 'idle' || 
                          processingStage === 'extracting_transcript' || 
                          processingStage === 'identifying_speakers' 
                          ? 'bg-gray-400 w-0' 
                          : 'bg-green-600 w-full'
                    }`}>
                  </div>
                </div>
              </div>
            </div>
            
            {/* Step 4: Verifying Claims */}
            <div className="flex items-center">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center mr-3
                ${processingStage === 'verifying_claims' 
                  ? 'bg-blue-100 text-blue-600' 
                  : processingStage === 'idle' || 
                    processingStage === 'extracting_transcript' || 
                    processingStage === 'identifying_speakers' ||
                    processingStage === 'extracting_claims' 
                    ? 'bg-gray-100 text-gray-600' 
                    : 'bg-green-100 text-green-600'}`}>
                {processingStage === 'verifying_claims' ? (
                  <span className="text-xs font-medium">{withSpeakers ? '4' : '3'}</span>
                ) : processingStage === 'idle' || 
                    processingStage === 'extracting_transcript' || 
                    processingStage === 'identifying_speakers' ||
                    processingStage === 'extracting_claims' ? (
                  <span className="text-xs font-medium">{withSpeakers ? '4' : '3'}</span>
                ) : (
                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M5 12L10 17L20 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                )}
              </div>
              <div className="flex-1">
                <div className="flex justify-between text-sm">
                  <span className={processingStage === 'verifying_claims' 
                    ? 'text-gray-800 font-medium' 
                    : processingStage === 'idle' || 
                      processingStage === 'extracting_transcript' || 
                      processingStage === 'identifying_speakers' ||
                      processingStage === 'extracting_claims' 
                      ? 'text-gray-600' 
                      : 'text-green-600 font-medium'}>
                    Verifying Claims with Multiple AI Models
                  </span>
                  <span className={processingStage === 'verifying_claims' 
                    ? 'text-blue-600 font-medium' 
                    : processingStage === 'idle' || 
                      processingStage === 'extracting_transcript' || 
                      processingStage === 'identifying_speakers' ||
                      processingStage === 'extracting_claims' 
                      ? 'text-gray-600' 
                      : 'text-green-600 font-medium'}>
                    {processingStage === 'verifying_claims' 
                      ? 'In Progress' 
                      : processingStage === 'idle' || 
                        processingStage === 'extracting_transcript' || 
                        processingStage === 'identifying_speakers' ||
                        processingStage === 'extracting_claims' 
                        ? 'Waiting' 
                        : 'Complete'}
                  </span>
                </div>
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden mt-1">
                  <div 
                    className={`h-full rounded-full ${
                      processingStage === 'verifying_claims' 
                        ? 'bg-blue-600 animate-pulse w-3/4' 
                        : processingStage === 'idle' || 
                          processingStage === 'extracting_transcript' || 
                          processingStage === 'identifying_speakers' ||
                          processingStage === 'extracting_claims' 
                          ? 'bg-gray-400 w-0' 
                          : 'bg-green-600 w-full'
                    }`}>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <p className="text-gray-600 text-sm mt-4">
            This may take several minutes for longer videos. Please don't close this window.
          </p>
        </div>
      )}
      
      {/* Transparency Note */}
      <div className="mt-6 pt-4 border-t border-gray-200">
        <div className="flex items-start text-xs text-gray-500">
          <Info className="h-4 w-4 text-gray-400 mt-0.5 mr-2 flex-shrink-0" />
          <p>
            Civic verifies videos using multiple AI models (OpenAI, Anthropic, and Perplexity) to ensure accurate, 
            balanced fact-checking. All processing is transparent, with detailed reasoning and evidence available 
            for each verification result.
          </p>
        </div>
      </div>
    </div>
  );
};

export default VideoInput;