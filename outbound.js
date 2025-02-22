import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import dotenv from 'dotenv';
import Fastify from 'fastify';
import Twilio from 'twilio';
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { createClient } from '@supabase/supabase-js'

// https://elevenlabs.io/docs/conversational-ai/guides/twilio/outbound-calling

// Load environment variables from .env file
dotenv.config();

// Check for required environment variables
const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  SUPABASE_URL,
  SUPABASE_KEY,
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER
) {
  console.error('Missing required environment variables');
  throw new Error('Missing required environment variables');
}

// Initialize Fastify server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8000;

// Root route for health check
fastify.get('/', async (_, reply) => {
  reply.send({ message: 'Server is running' });
});

// Initialize Twilio client
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Initialize Supabase client
// const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Helper function to get signed URL for authenticated conversations
async function getSignedUrl() {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: 'GET',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error('Error getting signed URL:', error);
    throw error;
  }
}

// Route to initiate outbound calls
fastify.post('/outbound-call', async (request, reply) => {
  const { number, patient_id, call_type } = request.body;
  const call_id = uuidv4();

  // Initialize default dynamic variables
  let dynamicVariables = {
    name: '',
    age: '',
    language: 'English',
    interests: '',
    medications: '',
    recent_conversations: 'No previous call data',
  };
  
  try {
    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/getCallContext?id=${call_id}&patientId=${patient_id}`,
      {
        headers: {
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    if (response.ok) {
      const context = await response.json();
      
      // Set dynamic variables based on context
      dynamicVariables = {
        name: context.patient.name,
        interests: context.interests ? 
          "Here is a list of interests: " + context.interests.map(i => i.name).join(', ') : 'No interests',
        medications: context.medications ? 
          "Here is a list of medications: " + context.medications.map(m => `${m.name} ${m.dosage} ${m.frequency}`).join(', ') : 'No medications',
        recent_conversations: context.recentCalls ? 
          `Here is a summary of recent conversations: ${context.recentCalls.map(call => `${call.summary}`).join(', ')}` : 'No previous call data',
        relevant_news: context.relevantNews ? 
          "Here is a list of relevant news related to thier interests: " + context.relevantNews.map(news => `${news.title} ${news.summary}`).join(', ') : 'No relevant news'
      };
    }
  } catch (error) {
    console.error('Error fetching call context:', error);
    // Continue with default dynamic variables if context fetch fails
  }

  if (!number) {
    return reply.code(400).send({ error: 'Phone number is required' });
  }

  try {
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${request.headers.host}/outbound-call-twiml?dynamic_variables=${encodeURIComponent(
        JSON.stringify(dynamicVariables)
      )}`,
    });

    reply.send({
      success: true,
      message: 'Call initiated',
      callSid: call.sid,
    });
  } catch (error) {
    console.error('Error initiating outbound call:', error);
    reply.code(500).send({
      success: false,
      error: 'Failed to initiate call',
    });
  }
});

// TwiML route for outbound calls
fastify.all('/outbound-call-twiml', async (request, reply) => {
    const dynamic_variables = request.query.dynamic_variables || '';
    const first_message = request.query.first_message || '';

    // Escape special characters for XML
    const escapedDynamicVariables = dynamic_variables
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    const escapedFirstMessage = first_message
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Connect>
            <Stream url="wss://${request.headers.host}/outbound-media-stream">
                <Parameter name="variables" value="${escapedDynamicVariables}"/>
                <Parameter name="first_message" value="${escapedFirstMessage}"/>
            </Stream>
        </Connect>
    </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for handling media streams
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get('/outbound-media-stream', { websocket: true }, (ws, req) => {
    console.info('[Server] Twilio connected to outbound media stream');

    // Variables to track the call
    let streamSid = null;
    let callSid = null;
    let elevenLabsWs = null;
    let customParameters = null; // Add this to store parameters

    // Handle WebSocket errors
    ws.on('error', console.error);

    // Set up ElevenLabs connection
    const setupElevenLabs = async () => {
      try {
        const signedUrl = await getSignedUrl();
        elevenLabsWs = new WebSocket(signedUrl);

        elevenLabsWs.on('open', () => {
          console.log('[ElevenLabs] Connected to Conversational AI');

          // Send initial configuration with prompt and first message
          const initialConfig = {
            type: 'conversation_initiation_client_data',
            conversation_config_override: {
              agent: {
                dynamicVariables: JSON.parse(customParameters?.variables || '{}'),
                prompt: {
                  prompt: `You are a friendly AI assistant calling to check in. Be friendly and empathetic. Ask about their well-being and medications. You can discuss their interests.`,
                },
                first_message: 'Hello! How are you doing today?',
              },
            },
          };

          console.log(
            '[ElevenLabs] Sending initial config with prompt:',
            initialConfig.conversation_config_override.agent.prompt.prompt
          );

          console.log(
            '[ElevenLabs] Sending initial config with first message:',
            initialConfig.conversation_config_override.agent.dynamicVariables
          );

          // Send the configuration to ElevenLabs
          elevenLabsWs.send(JSON.stringify(initialConfig));
        });

        elevenLabsWs.on('message', (data) => {
          try {
            const message = JSON.parse(data);

            switch (message.type) {
              case 'conversation_initiation_metadata':
                console.log('[ElevenLabs] Received initiation metadata');
                break;

              case 'audio':
                if (streamSid) {
                  if (message.audio?.chunk) {
                    const audioData = {
                      event: 'media',
                      streamSid,
                      media: {
                        payload: message.audio.chunk,
                      },
                    };
                    ws.send(JSON.stringify(audioData));
                  } else if (message.audio_event?.audio_base_64) {
                    const audioData = {
                      event: 'media',
                      streamSid,
                      media: {
                        payload: message.audio_event.audio_base_64,
                      },
                    };
                    ws.send(JSON.stringify(audioData));
                  }
                } else {
                  console.log('[ElevenLabs] Received audio but no StreamSid yet');
                }
                break;

              case 'interruption':
                if (streamSid) {
                  ws.send(
                    JSON.stringify({
                      event: 'clear',
                      streamSid,
                    })
                  );
                }
                break;

              case 'ping':
                if (message.ping_event?.event_id) {
                  elevenLabsWs.send(
                    JSON.stringify({
                      type: 'pong',
                      event_id: message.ping_event.event_id,
                    })
                  );
                }
                break;

              case 'agent_response':
                console.log(
                  `[Twilio] Agent response: ${message.agent_response_event?.agent_response}`
                );
                break;

              case 'user_transcript':
                console.log(
                  `[Twilio] User transcript: ${message.user_transcription_event?.user_transcript}`
                );
                break;

              default:
                console.log(`[ElevenLabs] Unhandled message type: ${message.type}`);
            }
          } catch (error) {
            console.error('[ElevenLabs] Error processing message:', error);
          }
        });

        elevenLabsWs.on('error', (error) => {
          console.error('[ElevenLabs] WebSocket error:', error);
        });

        elevenLabsWs.on('close', () => {
          console.log('[ElevenLabs] Disconnected');
        });
      } catch (error) {
        console.error('[ElevenLabs] Setup error:', error);
      }
    };

    // Set up ElevenLabs connection
    setupElevenLabs();

    // Handle messages from Twilio
    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message);
        if (msg.event !== 'media') {
          console.log(`[Twilio] Received event: ${msg.event}`);
        }

        switch (msg.event) {
          case 'start':
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;
            customParameters = msg.start.customParameters; // Store parameters
            console.log(`[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
            console.log('[Twilio] Start parameters:', customParameters);
            break;

          case 'media':
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              const audioMessage = {
                user_audio_chunk: Buffer.from(msg.media.payload, 'base64').toString('base64'),
              };
              elevenLabsWs.send(JSON.stringify(audioMessage));
            }
            break;

          case 'stop':
            console.log(`[Twilio] Stream ${streamSid} ended`);
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              elevenLabsWs.close();
            }
            break;

          default:
            console.log(`[Twilio] Unhandled event: ${msg.event}`);
        }
      } catch (error) {
        console.error('[Twilio] Error processing message:', error);
      }
    });

    // Handle WebSocket closure
    ws.on('close', () => {
      console.log('[Twilio] Client disconnected');
      if (elevenLabsWs?.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
    });
  });
});

// Start the Fastify server
fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});
