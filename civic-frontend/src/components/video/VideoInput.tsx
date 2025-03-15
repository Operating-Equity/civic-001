import React, { useState, useRef } from 'react';
import { AlertCircle, Upload, Link2, X } from 'lucide-react';

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
          <Link2 className="h-4 w-4 inline-block mr-2" />
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
            <div className="bg-white border border-gray-300 focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500 transition-colors rounded-xl overflow-hidden">
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
          
          <div className="flex justify-center">
            <button 
              type="submit" 
              disabled={!videoUrl.trim() || isProcessing}
              className="px-5 py-2.5 font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center min-w-[180px] bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white shadow-sm"
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
              border-2 border-dashed rounded-xl p-6
              ${isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 bg-gray-50'}
              ${selectedFile ? 'border-blue-500 bg-blue-50' : ''}
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
          
          <div className="flex justify-center">
            <button 
              type="submit" 
              disabled={!selectedFile || isProcessing}
              className="px-5 py-2.5 font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center min-w-[180px] bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white shadow-sm"
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
    </div>
  );
};

export default VideoInput;