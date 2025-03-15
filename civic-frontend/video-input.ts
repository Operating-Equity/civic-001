import React, { useState, useRef } from 'react';
import { Upload, Link, X } from 'lucide-react';

interface VideoInputProps {
  onVideoSubmit: (input: { type: 'file' | 'url'; value: File | string; model?: string }) => void;
  isProcessing: boolean;
}

const VideoInput: React.FC<VideoInputProps> = ({ onVideoSubmit, isProcessing }) => {
  const [url, setUrl] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedModel, setSelectedModel] = useState('sonar-reasoning-pro');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  };

  const handleFileSelect = (file: File) => {
    // Check if file is a video
    if (!file.type.startsWith('video/')) {
      alert('Please upload a video file.');
      return;
    }
    
    setSelectedFile(file);
    // Clear URL input when file is selected
    setUrl('');
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFileSelect(e.target.files[0]);
    }
  };

  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUrl(e.target.value);
    // Clear file selection when URL is entered
    setSelectedFile(null);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (selectedFile) {
      onVideoSubmit({ 
        type: 'file', 
        value: selectedFile,
        model: selectedModel
      });
    } else if (url.trim()) {
      onVideoSubmit({ 
        type: 'url', 
        value: url.trim(),
        model: selectedModel
      });
    }
  };

  const handleClearFile = () => {
    setSelectedFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="space-y-6">
      {/* Upload Box */}
      <div 
        className="glass-panel p-8 cursor-pointer"
        onDragEnter={handleDrag}
        onClick={() => fileInputRef.current?.click()}
      >
        <div
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          className={`
            relative border-2 border-dashed rounded-xl p-8 text-center transition-all
            ${dragActive ? 'border-primary bg-primary/10' : 'border-white/30'}
            ${selectedFile ? 'bg-primary/5' : ''}
          `}
        >
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept="video/*"
            className="hidden"
          />
          
          <div className="space-y-4">
            <Upload className="mx-auto h-12 w-12 text-white/50" />
            <div className="space-y-2">
              {selectedFile ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-center space-x-2">
                    <span className="text-lg font-medium text-white">{selectedFile.name}</span>
                    <button 
                      onClick={(e) => {
                        e.stopPropagation();
                        handleClearFile();
                      }}
                      className="p-1 rounded-full bg-white/10 hover:bg-white/20 text-white/70"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <p className="text-sm text-white/70">
                    {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                  </p>
                </div>
              ) : (
                <>
                  <p className="text-xl font-medium text-white">Upload video file</p>
                  <p className="text-sm text-white/70">
                    Drag and drop or click to upload
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* URL Input */}
      <form onSubmit={handleSubmit} className="glass-panel p-8">
        <div className="space-y-4">
          <div className="flex items-center space-x-2">
            <Link className="h-5 w-5 text-white/70" />
            <p className="text-xl font-medium text-white">YouTube URL Analysis</p>
          </div>
          
          <div className="space-y-4">
            <div className="relative">
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="w-full bg-white/10 border border-white/20 rounded-lg text-white p-3 outline-none focus:border-primary transition-colors"
              >
                <option value="sonar-reasoning-pro">Sonar Reasoning Pro</option>
                <option value="sonar-pro">Sonar Pro (200k)</option>
                <option value="sonar-reasoning">Sonar Reasoning</option>
                <option value="sonar">Sonar (127k)</option>
                <option value="llama-3.1-sonar-huge-128k-online">Llama 3.1 Huge</option>
              </select>
            </div>
            
            <div className="flex space-x-2">
              <input
                type="url"
                value={url}
                onChange={handleUrlChange}
                placeholder="https://youtube.com/watch?v=..."
                className="flex-1 bg-white/10 border border-white/20 rounded-lg text-white p-3 outline-none focus:border-primary transition-colors"
                disabled={isProcessing || !!selectedFile}
              />
              <button 
                type="submit" 
                disabled={(!url.trim() && !selectedFile) || isProcessing}
                className="min-w-[120px] bg-primary hover:bg-primary-600 disabled:bg-primary-900 disabled:text-white/50 text-white font-medium px-6 py-3 rounded-lg shadow-md transition-all duration-200 transform hover:translate-y-[-1px] active:translate-y-[1px]"
              >
                {isProcessing ? (
                  <div className="flex items-center justify-center space-x-2">
                    <div className="animate-spin h-4 w-4 border-2 border-white/50 border-t-white rounded-full"></div>
                    <span>Processing</span>
                  </div>
                ) : (
                  'Analyze'
                )}
              </button>
            </div>
          </div>
          
          <p className="text-sm text-white/50 italic">
            Provide a YouTube URL or upload a video file to analyze for factual claims.
          </p>
        </div>
      </form>
    </div>
  );
};

export default VideoInput;
