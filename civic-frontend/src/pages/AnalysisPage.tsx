import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, Download, Share2, Bookmark, AlertTriangle, Users, Award } from 'lucide-react';
import VideoThumbnail from '../components/video/VideoThumbnail';
import TranscriptDisplay from '../components/video/TranscriptDisplay';
import Summary from '../components/analysis/Summary';
import AnalysisResults from '../components/analysis/AnalysisResults';
import KeywordGeneration from '../components/search/KeywordGeneration';
import EvidenceResults from '../components/search/EvidenceResults';
import SpeakerIdentification from '../components/analysis/SpeakerIdentification';
import VerificationCertificate from '../components/analysis/VerificationCertificate';

interface AnalysisPageProps {
  certificateView?: boolean;
}

const AnalysisPage: React.FC<AnalysisPageProps> = ({ certificateView = false }) => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'analysis' | 'evidence' | 'certificate'>(
    certificateView ? 'certificate' : 'analysis'
  );
  
  // Placeholder states
  const [data, setData] = useState<any>(null);
  
  useEffect(() => {
    // Update tab if certificateView prop changes
    if (certificateView) {
      setActiveTab('certificate');
    }
  }, [certificateView]);
  
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
            empiricalClaims: [
              {
                id: '1',
                claim: 'This is a sample claim for demonstration purposes.',
                context: 'This is the context for the claim.',
                validationPotential: 'This is how the claim could be validated.',
                speaker: { id: 'speaker1', name: 'Speaker A' }
              }
            ],
            perplexityResults: [
              {
                statement: 'This is a sample claim for demonstration purposes.',
                classification: 'TRUE',
                confidence: 80,
                supportingFacts: 'These are supporting facts for the claim.',
                model: 'Perplexity',
                claimId: '1'
              }
            ],
            openAIResults: [
              {
                statement: 'This is a sample claim for demonstration purposes.',
                classification: 'TRUE',
                confidence: 85,
                supportingFacts: 'These are supporting facts from OpenAI.',
                model: 'OpenAI',
                claimId: '1'
              }
            ],
            anthropicResults: [
              {
                statement: 'This is a sample claim for demonstration purposes.',
                classification: 'TRUE',
                confidence: 82,
                supportingFacts: 'These are supporting facts from Anthropic.',
                model: 'Anthropic',
                claimId: '1'
              }
            ],
            keywordResults: [
              {
                claim: 'This is a sample claim for demonstration purposes.',
                searchQueries: ['sample claim evidence', 'demonstration purposes facts']
              }
            ],
            searchResults: [],
            speakers_data: {
              speakers: {
                'speaker1': 'Speaker A',
                'speaker2': 'Speaker B'
              },
              segments: [
                {
                  speaker: 'speaker1',
                  start: 0,
                  end: 10,
                  text: 'This is a sample segment from Speaker A.'
                },
                {
                  speaker: 'speaker2',
                  start: 11,
                  end: 20,
                  text: 'This is a sample segment from Speaker B.'
                }
              ]
            }
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
          <div className="bg-white p-12 rounded-lg shadow-sm border border-gray-200 flex flex-col items-center justify-center">
            <div className="animate-spin h-12 w-12 border-4 border-blue-600 border-t-transparent rounded-full mb-4"></div>
            <p className="text-xl font-medium text-gray-800">Loading Analysis</p>
            <p className="text-gray-600 mt-2">Please wait...</p>
          </div>
        </div>
      </div>
    );
  }
  
  if (error || !data) {
    return (
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white p-8 rounded-lg shadow-sm border border-gray-200">
            <div className="flex items-center space-x-3 text-gray-800 mb-4">
              <AlertTriangle className="h-6 w-6 text-red-500" />
              <h2 className="text-xl font-semibold">Error</h2>
            </div>
            <p className="text-gray-700 mb-6">{error || 'Failed to load analysis'}</p>
            <button
              onClick={() => navigate('/')}
              className="flex items-center space-x-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-lg transition-colors border border-gray-200"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>Return to Home</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Render certificate view only if certificateView is true
  if (certificateView) {
    return (
      <div className="container mx-auto px-4 py-10">
        <div className="max-w-4xl mx-auto">
          <div className="flex justify-between items-center mb-6">
            <h1 className="text-2xl font-bold text-gray-900">Verification Certificate</h1>
            <button
              onClick={() => navigate('/')}
              className="flex items-center space-x-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-lg transition-colors border border-gray-200"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>Return to Home</span>
            </button>
          </div>
          
          <VerificationCertificate
            videoTitle={data.videoTitle}
            thumbnailUrl={data.thumbnailUrl}
            claims={data.empiricalClaims}
            perplexityResults={data.perplexityResults}
            openAIResults={data.openAIResults}
            anthropicResults={data.anthropicResults}
          />
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
            className="flex items-center space-x-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-800 rounded-lg transition-colors border border-gray-200"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Back</span>
          </button>
          
          <div className="flex items-center space-x-3 mt-4 sm:mt-0">
            <button
              onClick={() => setActiveTab('analysis')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center space-x-1.5
                ${activeTab === 'analysis' 
                  ? 'bg-blue-50 text-blue-700 border border-blue-100' 
                  : 'bg-gray-100 text-gray-600 hover:text-gray-800 hover:bg-gray-200 border border-gray-200'}
              `}
            >
              <span>Analysis</span>
            </button>
            
            <button
              onClick={() => setActiveTab('evidence')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center space-x-1.5
                ${activeTab === 'evidence' 
                  ? 'bg-blue-50 text-blue-700 border border-blue-100' 
                  : 'bg-gray-100 text-gray-600 hover:text-gray-800 hover:bg-gray-200 border border-gray-200'}
              `}
            >
              <span>Evidence</span>
            </button>
            
            <button
              onClick={() => setActiveTab('certificate')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center space-x-1.5
                ${activeTab === 'certificate' 
                  ? 'bg-blue-50 text-blue-700 border border-blue-100' 
                  : 'bg-gray-100 text-gray-600 hover:text-gray-800 hover:bg-gray-200 border border-gray-200'}
              `}
            >
              <Award className="h-4 w-4 mr-1" />
              <span>Certificate</span>
            </button>
          </div>
        </div>
        
        {/* Title */}
        <h1 className="text-2xl font-bold text-gray-900 mb-6">{data.videoTitle}</h1>
        
        {/* Analysis Content */}
        <div className="space-y-8">
          {activeTab === 'analysis' && (
            <>
              <VideoThumbnail thumbnailUrl={data.thumbnailUrl} videoTitle={data.videoTitle} />
              
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <TranscriptDisplay transcript={data.transcript} />
                <Summary summary={data.summary} videoTitle={data.videoTitle} />
              </div>
              
              {/* Speaker Identification */}
              {data.speakers_data && (
                <SpeakerIdentification 
                  speakersData={data.speakers_data}
                  claims={data.empiricalClaims} 
                />
              )}
              
              <AnalysisResults
                empiricalClaims={data.empiricalClaims}
                perplexityResults={data.perplexityResults}
                openAIResults={data.openAIResults}
                anthropicResults={data.anthropicResults}
                speakersData={data.speakers_data}
                videoTitle={data.videoTitle}
                thumbnailUrl={data.thumbnailUrl}
              />
            </>
          )}
          
          {activeTab === 'evidence' && (
            <>
              <KeywordGeneration
                keywordResults={data.keywordResults}
                onSearch={() => {}}
                isSearching={false}
              />
              
              <EvidenceResults
                searchResults={data.searchResults}
                isSearching={false}
              />
            </>
          )}
          
          {activeTab === 'certificate' && (
            <VerificationCertificate
              videoTitle={data.videoTitle}
              thumbnailUrl={data.thumbnailUrl}
              claims={data.empiricalClaims}
              perplexityResults={data.perplexityResults}
              openAIResults={data.openAIResults}
              anthropicResults={data.anthropicResults}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default AnalysisPage;