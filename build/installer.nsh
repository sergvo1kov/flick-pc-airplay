; Windows Firewall rules so iPhone/iPad can find and stream to this PC.
; AirPlay discovery (mDNS, UDP 5353) and streaming (TCP/UDP) are inbound, so
; both the engine and the app (DACP remote-control lookups) need a rule.
; Scope: Private and Domain networks only - not public Wi-Fi.

!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Flick AirPlay Engine"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Flick AirPlay"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Flick AirPlay Engine" dir=in action=allow program="$INSTDIR\resources\engine\bin\uxplay.exe" enable=yes profile=private,domain'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Flick AirPlay" dir=in action=allow program="$INSTDIR\FlickAirPlay.exe" enable=yes profile=private,domain'
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Flick AirPlay Engine"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Flick AirPlay"'
!macroend
