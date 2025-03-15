import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Download, Share2, Bookmark, AlertTriangle } from 'lucide-react';
import VideoThumbnail from '../components/video/VideoThumbnail';
import TranscriptDisplay from '../components/video/TranscriptDisplay';
import Summary from '../components/analysis/Summary';
import AnalysisResults from '../components/analysis/AnalysisResults';
import KeywordGeneration from '../components/search/KeywordGeneration';
import EvidenceResults from '../components/search/EvidenceResults';

// For now, this is a placeholder since we don't have actual saved analysis
// In a real app, this would fetch the analysis from an API
const AnalysisPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Placeholder states
  const [data, setData] = useState<any>(null);
  
  useEffect(() => {
    // Simulating API call to get analysis
    const fetchAnalysis = async () => {
      try {
        setLoading(true);
        
        // In a real app, this would be an API call
        // For demo, we'll simulate a response after a delay
        setTimeout(() => {
          // If ID doesn't exist or is invalid
          if (!id || id === 'undefined') {
            setError('Analysis not found');
            setLoading(false);
            return;
          }
          
          // Mock data
          setData({
            id,
            videoTitle: 'Sample Analysis',
            transcript: 'This is a sample transcript for demonstration purposes.',
            summary: 'This is a summary of the analysis.',
            thumbnailUrl: 'https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
            empiricalClaims: [],
            perplexityResults: [],
            openAIResults: [],
            anthropicResults: [],
            keywordResults: [],
            searchResults: []
          });
          
          setLoading(false);
        }, 1500);
      } catch (err) {
        setError('Failed to load analysis');
        setLoading(false);
      }
    };
    
    fetchAnalysis();
  }, [id]);
  
  if (loading) {
    return (
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-4xl mx-auto">
          <div className="glass-panel p-12 flex flex-col items-center justify-center">
            <div className="animate-spin h-12 w-12 border-4 border-primary border-t-transparent rounded-full mb-4"></div>
            <p className="text-xl font-medium text-white">Loading Analysis</p>
            <p className="text-white/70 mt-2">Please wait...</p>
          </div>
        </div>
      </div>
    );
  }
  
  if (error || !data) {
    return (
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-4xl mx-auto">
          <div className="glass-panel p-8">
            <div className="flex items-center space-x-3 text-white mb-4">
              <AlertTriangle className="h-6 w-6 text-red-500" />
              <h2 className="text-xl font-semibold">Error</h2>
            </div>
            <p className="text-white/90 mb-6">{error || 'Failed to load analysis'}</p>
            <button
              onClick={() => navigate('/')}
              className="flex items-center space-x-2 px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>Return to Home</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-10">
      <div className="max-w-6xl mx-auto">
        {/* Navigation/Action Bar */}
        <div className="flex flex-wrap items-center justify-between mb-8">
          <button
            onClick={() => navigate('/')}
            className="flex items-center space-x-2 px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Back</span>
          </button>
          
          <div className="flex items-center space-x-3 mt-4 sm:mt-0">
            <button className="flex items-center space-x-1 px-3 py-1.5 bg-white/5 hover:bg-white/10 text-white rounded-lg transition-colors text-sm">
              <Download className="h-4 w-4" />
              <span>Export</span>
            </button>
            
            <button className="flex items-center space-x-1 px-3 py-1.5 bg-white/5 hover:bg-white/10 text-white rounded-lg transition-colors text-sm">
              <Share2 className="h-4 w-4" />
              <span>Share</span>
            </button>
            
            <button className="flex items-center space-x-1 px-3 py-1.5 bg-white/5 hover:bg-white/10 text-white rounded-lg transition-colors text-sm">
              <Bookmark className="h-4 w-4" />
              <span>Save</span>
            </button>
          </div>
        </div>
        
        {/* Title */}
        <h1 className="text-2xl font-bold text-white mb-6">{data.videoTitle}</h1>
        
        {/* Analysis Content */}
        <div className="space-y-8">
          <VideoThumbnail thumbnailUrl={data.thumbnailUrl} videoTitle={data.videoTitle} />
          
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <TranscriptDisplay transcript={data.transcript} />
            <Summary summary={data.summary} videoTitle={data.videoTitle} />
          </div>
          
          <AnalysisResults
            empiricalClaims={data.empiricalClaims}
            perplexityResults={data.perplexityResults}
            openAIResults={data.openAIResults}
            anthropicResults={data.anthropicResults}
          />
          
          <KeywordGeneration
            keywordResults={data.keywordResults}
            onSearch={() => {}}
            isSearching={false}
          />
          
          <EvidenceResults
            searchResults={data.searchResults}
            isSearching={false}
          />
        </div>
      </div>
    </div>
  );
};

export default AnalysisPage;
