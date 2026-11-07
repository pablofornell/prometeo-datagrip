//-----------------------------------------------------------------------------
// cancel.rs
//
// PATCH (Prometeo): handle that interrupts the call running on a connection
// from another thread, by writing a break marker packet to the socket.
//-----------------------------------------------------------------------------

use std::io::Write;
use std::net::TcpStream;

use crate::client::BreakStateRef;
use crate::constants;
use crate::error::Error;

/// Interrupts the call in progress on the connection it was created from (the call fails with ORA-01013). Safe to
/// use from any thread and to call at any time: it does nothing when no call is running.
pub struct CancelHandle {
    socket: TcpStream,
    full_packet_size: bool,
    state: BreakStateRef,
}

impl CancelHandle {
    pub(crate) fn new(
        socket: TcpStream,
        full_packet_size: bool,
        state: BreakStateRef,
    ) -> Self {
        Self { socket, full_packet_size, state }
    }

    /// Sends the break. Returns true when a call was running and the break was sent.
    pub fn cancel(&self) -> Result<bool, Error> {
        let mut state = self.state.lock()?;
        if !state.in_call {
            return Ok(false);
        }
        if state.sent {
            // the previous break has not been answered yet
            return Ok(true);
        }
        let mut packet = Vec::with_capacity(11);
        if self.full_packet_size {
            packet.extend(11u32.to_be_bytes());
        } else {
            packet.extend(11u16.to_be_bytes());
            packet.extend([0, 0]);
        }
        packet.extend([constants::PACKET_TYPE_MARKER, 0, 0, 0]);
        packet.extend([1, 0, constants::MARKER_TYPE_INTERRUPT]);
        (&self.socket).write_all(&packet)?;
        state.sent = true;
        Ok(true)
    }
}
