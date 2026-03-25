import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { socket } from '../utils/socket';
import VideoCall from './VideoCall';

const EmojiPicker = lazy(() => import('emoji-picker-react'));

const API_URL = 'https://chatgram-production.up.railway.app/api';

function Chat({ currentUser, onLogout }) {
  const [users, setUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const profilePicInputRef = useRef(null);

  const [myUser, setMyUser] = useState(currentUser);
  const [onlineUsers, setOnlineUsers] = useState([]);

  const [typingUsers, setTypingUsers] = useState(new Set());
  const typingTimeoutRef = useRef(null);

  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  const usersRef = useRef([]);
  const ringtoneRef = useRef(null);

  useEffect(() => { usersRef.current = users; }, [users]);

  useEffect(() => {
    ringtoneRef.current = new Audio('https://actions.google.com/sounds/v1/alarms/phone_ringing.ogg');
    ringtoneRef.current.loop = true;
    
    if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
      Notification.requestPermission();
    }
  }, []);

  const showDesktopNotification = (title, body) => {
    if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
      new Notification(title, { body });
    }
  };

  useEffect(() => {
    if (receivingCall && !callActive) {
      ringtoneRef.current?.play().catch(e => console.log('Ringtone autoplay blocked', e));
    } else {
      if (ringtoneRef.current) {
        ringtoneRef.current.pause();
        ringtoneRef.current.currentTime = 0;
      }
    }
  }, [receivingCall, callActive]);

  const playNotificationSound = () => {
    try {
      const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3');
      audio.volume = 0.5;
      audio.play().catch(e => console.log('Audio blocked:', e));
    } catch (e) {}
  };

  // WebRTC Call State
  const [receivingCall, setReceivingCall] = useState(false);
  const [caller, setCaller] = useState('');
  const [callerName, setCallerName] = useState('');
  const [callerSignal, setCallerSignal] = useState(null);
  const [callActive, setCallActive] = useState(false);
  const [callType, setCallType] = useState(null);

  useEffect(() => {
    // Connect to Socket.io
    socket.connect();
    socket.emit('join', currentUser.id.toString());

    // Fetch user list
    fetch(`${API_URL}/auth/users`)
      .then(res => res.json())
      .then(data => setUsers(data.filter(u => u.id !== currentUser.id)))
      .catch(err => console.error("Error fetching users", err));

    socket.on('online_users', (usersArray) => {
      setOnlineUsers(usersArray);
    });

    // Listen for incoming messages
    socket.on('receive_message', (message) => {
      setMessages((prev) => [...prev, message]);
      if (message.sender_id !== currentUser.id) {
        playNotificationSound();
        const sender = usersRef.current.find(u => u.id === message.sender_id);
        const callerName = sender ? sender.name : 'Someone';
        const bodyText = message.type === 'text' ? message.content : `Sent a ${message.type}`;
        showDesktopNotification(`New message from ${callerName}`, bodyText);
      }
      setTypingUsers(prev => {
        const next = new Set(prev);
        next.delete(message.sender_id);
        return next;
      });
    });

    socket.on('user_typing', (data) => {
      setTypingUsers(prev => new Set(prev).add(data.sender_id));
    });

    socket.on('user_stop_typing', (data) => {
      setTypingUsers(prev => {
        const next = new Set(prev);
        next.delete(data.sender_id);
        return next;
      });
    });

    // Listen for incoming calls
    socket.on('incoming_call', (data) => {
      setReceivingCall(true);
      setCaller(data.from.toString());
      setCallerName(data.name);
      setCallerSignal(data.signal);
      if (data.callType) setCallType(data.callType);
      showDesktopNotification('Incoming Call', `${data.name} is calling you via ${data.callType || 'voice'}...`);
    });

    return () => {
      socket.off('online_users');
      socket.off('receive_message');
      socket.off('user_typing');
      socket.off('user_stop_typing');
      socket.off('incoming_call');
      socket.off('incoming_call');
      socket.disconnect();
    };
  }, [currentUser]);

  useEffect(() => {
    // Scroll to bottom when messages change
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    // When a user is selected, fetch chat history
    if (selectedUser) {
      fetch(`${API_URL}/auth/messages/${currentUser.id}/${selectedUser.id}`)
        .then(res => res.json())
        .then(data => setMessages(data))
        .catch(err => console.error("Error fetching messages", err));
    }
  }, [selectedUser, currentUser]);

  const sendMessage = async (e) => {
    e?.preventDefault();
    if (!inputText.trim() || !selectedUser) return;
    
    setShowEmojiPicker(false);

    const messageData = {
      sender_id: currentUser.id,
      receiver_id: selectedUser.id,
      type: 'text',
      content: inputText,
      file_url: null
    };

    socket.emit('send_message', messageData);
    socket.emit('stop_typing', { sender_id: currentUser.id, receiver_id: selectedUser.id });
    setInputText('');
    playNotificationSound();
  };

  const handleTyping = (e) => {
    setInputText(e.target.value);
    if (!selectedUser) return;
    
    socket.emit('typing', { sender_id: currentUser.id, receiver_id: selectedUser.id });
    
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      socket.emit('stop_typing', { sender_id: currentUser.id, receiver_id: selectedUser.id });
    }, 1500);
  };

  const uploadAndSendFile = async (file, overrideType) => {
    if (!file || !selectedUser) return;
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch(`${API_URL}/upload`, { method: 'POST', body: formData });
      const data = await res.json();

      let type = overrideType || 'file';
      if (!overrideType) {
        if (file.type.startsWith('image/')) type = 'image';
        else if (file.type.startsWith('video/')) type = 'video';
        else if (file.type.startsWith('audio/')) type = 'audio';
      }

      const messageData = {
        sender_id: currentUser.id, receiver_id: selectedUser.id,
        type: type, content: file.name || 'Voice Message', file_url: data.fileUrl
      };

      socket.emit('send_message', messageData);
      socket.emit('stop_typing', { sender_id: currentUser.id, receiver_id: selectedUser.id });
      playNotificationSound();
    } catch (err) { console.error('Error uploading file', err); }
  };

  const handleFileUpload = (e) => uploadAndSendFile(e.target.files[0]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const file = new File([audioBlob], `voice-${Date.now()}.webm`, { type: 'audio/webm' });
        uploadAndSendFile(file, 'audio');
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      alert("Microphone access is required for voice messages.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const handleProfilePicUpdate = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    
    try {
      const uploadRes = await fetch(`${API_URL}/upload`, { method: 'POST', body: formData });
      const { fileUrl } = await uploadRes.json();
      
      const updateRes = await fetch(`${API_URL}/auth/user/${myUser.id}/profile-pic`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_pic: fileUrl })
      });
      const data = await updateRes.json();
      if (data.success) {
        const updatedUser = { ...myUser, profile_pic: data.profile_pic };
        setMyUser(updatedUser);
        localStorage.setItem('user', JSON.stringify(updatedUser));
      }
    } catch (err) { console.error('Error updating profile pic', err); }
  };

  const Avatar = ({ user, onClick, style = {}, title }) => {
    if (user?.profile_pic) {
      return (
        <img src={`https://chatgram-production.up.railway.app${user.profile_pic}`} alt="avatar" 
             className="avatar" style={{ objectFit: 'cover', cursor: onClick ? 'pointer' : 'default', ...style }} 
             onClick={onClick} title={title} />
      );
    }
    return (
      <div className="avatar" style={{ cursor: onClick ? 'pointer' : 'default', ...style }} onClick={onClick} title={title}>
        {getInitials(user?.name)}
      </div>
    );
  };

  const startCall = (type) => {
    if (!selectedUser) return;
    setCallType(type);
    setCallActive(true);
  };

  const handleAcceptCall = () => {
    setCallActive(true);
    // Setting selectedUser to the caller so the VideoCall component knows who we are talking to
    const callingUser = users.find(u => u.id.toString() === caller);
    if (callingUser) setSelectedUser(callingUser);
  };

  const handleDeclineCall = () => {
    setReceivingCall(false);
    socket.emit('disconnect_call', { to: caller });
  };
  const getInitials = (name) => name ? name.charAt(0).toUpperCase() : '?';

  return (
    <div className={`app-container ${selectedUser ? 'mobile-chat-open' : ''}`}>
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <div className="user-profile">
            <input type="file" ref={profilePicInputRef} style={{display: 'none'}} onChange={handleProfilePicUpdate} accept="image/*" />
            <Avatar user={myUser} onClick={() => profilePicInputRef.current.click()} title="Click to update profile picture" />
            <div>
              <div style={{fontWeight: 600, fontSize: '15px'}}>{myUser.name}</div>
              <div style={{fontSize: '12px', color: 'var(--text-muted)'}}>Online</div>
            </div>
          </div>
          <button className="logout-btn" onClick={onLogout}>Logout</button>
        </div>
        
        <div className="user-list">
          <h4 style={{padding: '10px', fontSize: '12px', color: 'var(--text-muted)', textTransform: 'uppercase'}}>Contacts</h4>
          {users.map(user => (
            <div 
              key={user.id} 
              className={`user-item ${selectedUser?.id === user.id ? 'active' : ''}`}
              onClick={() => setSelectedUser(user)}
            >
              <Avatar user={user} style={{width: '35px', height: '35px', fontSize: '14px'}} />
              <div className="user-info" style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3>{user.name}</h3>
                  <div style={{
                    width: '10px', height: '10px', borderRadius: '50%', flexShrink: 0,
                    backgroundColor: onlineUsers.includes(user.id.toString()) ? 'var(--success)' : 'var(--text-muted)'
                  }} title={onlineUsers.includes(user.id.toString()) ? "Online" : "Offline"}></div>
                </div>
              </div>
            </div>
          ))}
          {users.length === 0 && <div style={{padding: '10px', color: 'var(--text-muted)'}}>No other users found. Register another account to chat!</div>}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="chat-area">
        {selectedUser ? (
          <>
            <div className="chat-header">
              <div className="chat-header-userinfo">
                <button className="mobile-back-btn" onClick={() => setSelectedUser(null)}>←</button>
                <Avatar user={selectedUser} style={{width: '35px', height: '35px', fontSize: '14px', flexShrink: 0}} />
                <h3>{selectedUser.name}</h3>
              </div>
              <div className="call-actions">
                <button onClick={() => startCall('voice')} title="Voice Call">📞</button>
                <button onClick={() => startCall('video')} title="Video Call" style={{display: 'none'}}>📹</button>
                <button title="More options">⋮</button>
              </div>
            </div>

            <div className="messages-list">
              {messages.length === 0 ? (
                <div className="empty-chat-state">
                  <p>No messages here yet...</p>
                  <p className="sub">Send a message or tap the greeting below.</p>
                  <div className="greeting-sticker" onClick={() => { setInputText('🐊 Hi!'); sendMessage(); }}>
                    <span style={{fontSize: '80px', display: 'block'}}>🐊</span>
                    <span style={{color: 'var(--secondary)', fontSize: '24px', fontWeight: 'bold', textShadow: '0 2px 4px rgba(0,0,0,0.5)'}}>Hi!</span>
                  </div>
                </div>
              ) : (
                messages.filter(m => 
                  (m.sender_id === currentUser.id && m.receiver_id === selectedUser.id) ||
                  (m.sender_id === selectedUser.id && m.receiver_id === currentUser.id)
                ).map((msg, index) => (
                  <div key={index} className={`message ${msg.sender_id === currentUser.id ? 'sent' : 'received'}`}>
                    {msg.type === 'text' && <p>{msg.content}</p>}
                    {msg.type === 'image' && (
                      <img src={`https://chatgram-production.up.railway.app${msg.file_url}`} alt="attachment" className="message-media" />
                    )}
                    {msg.type === 'video' && (
                      <video controls src={`https://chatgram-production.up.railway.app${msg.file_url}`} className="message-media" />
                    )}
                    {msg.type === 'audio' && (
                      <div style={{display: 'flex', flexDirection: 'column'}}>
                        <span style={{fontSize: '12px', marginBottom: '5px'}}>🎤 Voice Message</span>
                        <audio controls src={`https://chatgram-production.up.railway.app${msg.file_url}`} className="message-media" style={{height: '40px', maxWidth: '220px'}} />
                      </div>
                    )}
                    {msg.type === 'file' && (
                      <a href={`https://chatgram-production.up.railway.app${msg.file_url}`} target="_blank" rel="noreferrer" style={{color: 'white', textDecoration: 'underline'}}>
                        Download: {msg.content}
                      </a>
                    )}
                    <div style={{fontSize: '10px', opacity: 0.7, marginTop: '4px', textAlign: 'right'}}>
                      {new Date(msg.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                    </div>
                  </div>
                ))
              )}
              {typingUsers.has(selectedUser.id) && (
                <div className="typing-indicator-bubble">
                  <div className="dot"></div>
                  <div className="dot"></div>
                  <div className="dot"></div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <form className="chat-input-area" onSubmit={sendMessage}>
              {showEmojiPicker && (
                <div style={{position: 'absolute', bottom: '80px', left: '20px', zIndex: 100}}>
                  <Suspense fallback={<div style={{padding: '20px', background: 'var(--surface)', borderRadius: '10px'}}>Loading Emojis...</div>}>
                    <EmojiPicker onEmojiClick={(e) => setInputText(prev => prev + e.emoji)} theme="dark" />
                  </Suspense>
                </div>
              )}
              <div className="input-pill">
                <button type="button" className="icon-btn emoji-btn" title="Emoji" onClick={() => setShowEmojiPicker(!showEmojiPicker)}>😀</button>
                <input 
                  type="text" 
                  placeholder={isRecording ? "Recording audio..." : "Message"} 
                  value={inputText}
                  onChange={handleTyping}
                  disabled={isRecording}
                  onClick={() => setShowEmojiPicker(false)}
                />
                <button type="button" className="icon-btn attachment-btn" onClick={() => fileInputRef.current.click()} title="Attach File">📎</button>
              </div>
              <input type="file" ref={fileInputRef} style={{display: 'none'}} onChange={handleFileUpload} />
              
              {inputText.trim() ? (
                <button type="submit" className="round-action-btn" title="Send Message">➤</button>
              ) : (
                <button 
                  type="button" 
                  className={`round-action-btn ${isRecording ? 'recording' : ''}`} 
                  onClick={isRecording ? stopRecording : startRecording}
                  title={isRecording ? "Stop and Send" : "Record Voice Message"}
                >
                  {isRecording ? "⏹️" : "🎤"}
                </button>
              )}
            </form>
          </>
        ) : (
          <div style={{display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)'}}>
            <h3>Select a contact to start messaging</h3>
          </div>
        )}

        {/* Incoming Call Dialog */}
        {receivingCall && !callActive && (
          <div className="incoming-call-dialog">
            <div className="avatar" style={{width: '50px', height: '50px'}}>{getInitials(callerName)}</div>
            <div>
              <h3 style={{marginBottom: '5px'}}>{callerName}</h3>
              <p style={{color: 'var(--text-muted)', fontSize: '14px'}}>Incoming {callType === 'voice' ? 'Voice' : 'Video'} Call...</p>
            </div>
            <div className="incoming-actions">
              <button className="answer-call-btn" onClick={handleAcceptCall} style={{padding: '10px 20px'}}>Answer</button>
              <button className="end-call-btn" onClick={handleDeclineCall} style={{padding: '10px 20px'}}>Decline</button>
            </div>
          </div>
        )}

        {/* Video Call Overlay */}
        {callActive && (
          <VideoCall 
            currentUser={currentUser} 
            selectedUser={selectedUser} 
            socket={socket} 
            isReceiving={receivingCall}
            callerSignal={callerSignal}
            callerId={caller}
            callerName={callerName}
            callType={callType}
            onClose={() => {
              setCallActive(false);
              setCallerSignal(null);
              setCallType(null);
            }} 
          />
        )}
      </div>
    </div>
  );
}

export default Chat;
