import React, { useState, useRef } from 'react';
import { AlertCircle, Upload, Link, X } from 'lucide-react';
import { Button } from '../ui/Button';

interface VideoInputProps {
  onVideoSubmit: (input: { type: 'file' | 'url'; value: File | string }) => void;
  isProcessing?: boolean;
  error?: string | null;
}

const VideoInput: React.FC<VideoInputProps> = ({ 
  onVideoSubmit, 
  isProcessing = false, 
  error = null 
}) => {
  const [inputType, setInputType] = useState<'file' | 'url'>('url');
  const [videoUrl, setVideoUrl] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const handleUrlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (videoUrl.trim() && !isProcessing) {
      onVideoSubmit({ type: 'url', value: videoUrl.trim() });
    }
  };
  
  const handleFileSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedFile && !isProcessing) {
      onVideoSubmit({ type: 'file', value: selectedFile });
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
  
  return (
    <div className="glass-panel p-6">
      {/* Input Type Selector */}
      <div className="flex mb-6 bg-white/5 rounded-lg p-1 w-fit">
        <button
          onClick={() => setInputType('url')}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            inputType === 'url' 
              ? 'bg-primary text-white' 
              : 'text-white/70 hover:text-white hover:bg-white/10'
          }`}
        >
          <Link className="h-4 w-4 inline-block mr-2" />
          YouTube URL
        </button>
        <button
          onClick={() => setInputType('file')}
          className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            inputType === 'file' 
              ? 'bg-primary text-white' 
              : 'text-white/70 hover:text-white hover:bg-white/10'
          }`}
        >
          <Upload className="h-4 w-4 inline-block mr-2" />
          Upload Video
        </button>
      </div>
      
      {/* Error Message */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-6">
          <div className="flex items-start">
            <AlertCircle className="h-5 w-5 text-red-400 mt-0.5 mr-2 flex-shrink-0" />
            <p className="text-red-200 text-sm">{error}</p>
          </div>
        </div>
      )}
      
      {/* URL Input */}
      {inputType === 'url' && (
        <form onSubmit={handleUrlSubmit} className="space-y-4">
          <div>
            <label htmlFor="videoUrl" className="block text-white font-medium mb-2">
              Enter a YouTube Video URL
            </label>
            <input
              type="text"
              id="videoUrl"
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-primary"
              disabled={isProcessing}
            />
          </div>
          
          <Button 
            type="submit" 
            disabled={!videoUrl.trim() || isProcessing}
            isLoading={isProcessing && inputType === 'url'}
          >
            {isProcessing ? 'Processing Video...' : 'Analyze Video'}
          </Button>
        </form>
      )}
      
      {/* File Upload */}
      {inputType === 'file' && (
        <form onSubmit={handleFileSubmit} className="space-y-4">
          <div
            className={`
              border-2 border-dashed rounded-lg p-6
              ${isDragging ? 'border-primary bg-primary/10' : 'border-white/20 bg-white/5'}
              ${selectedFile ? 'border-green-500/50 bg-green-500/10' : ''}
              transition-colors duration-200
            `}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {selectedFile ? (
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-white font-medium">{selectedFile.name}</p>
                  <p className="text-white/50 text-sm">
                    {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB
                  </p>
                </div>
                <button
                  type="button"
                  onClick={clearFile}
                  className="text-white/70 hover:text-white p-1 rounded-full hover:bg-white/10"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            ) : (
              <div className="text-center">
                <Upload className="h-10 w-10 text-white/30 mx-auto mb-3" />
                <p className="text-white mb-2">Drag & drop your video file here</p>
                <p className="text-white/50 text-sm mb-4">Or select a file from your computer</p>
                <label
                  htmlFor="fileInput"
                  className="inline-block px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-md cursor-pointer transition-colors"
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
          
          <Button 
            type="submit" 
            disabled={!selectedFile || isProcessing}
            isLoading={isProcessing && inputType === 'file'}
          >
            {isProcessing ? 'Processing Video...' : 'Analyze Video'}
          </Button>
        </form>
      )}
      
      {/* Loading Status */}
      {isProcessing && (
        <div className="mt-6 pt-6 border-t border-white/10">
          <div className="flex items-center space-x-3">
            <div className="h-4 w-4 rounded-full border-2 border-primary border-t-transparent animate-spin"></div>
            <p className="text-white font-medium">Processing video</p>
          </div>
          <p className="text-white/50 text-sm mt-2">
            This may take several minutes for longer videos. Please don't close this window.
          </p>
        </div>
      )}
    </div>
  );
};

export default VideoInput;