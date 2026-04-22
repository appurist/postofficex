  $client = [System.Net.Sockets.TcpClient]::new("143.110.219.111", 2525)
  $stream = $client.GetStream()
  $reader = New-Object System.IO.StreamReader($stream)
  $writer = New-Object System.IO.StreamWriter($stream)
  $writer.NewLine = "`r`n"
  $writer.AutoFlush = $true

  $reader.ReadLine()
  $writer.WriteLine("EHLO test.local")
  Start-Sleep -Milliseconds 200
  while ($stream.DataAvailable) { $reader.ReadLine() }

  $writer.WriteLine("MAIL FROM:<sender@example.net>")
  $reader.ReadLine()

  $writer.WriteLine("RCPT TO:<your-user@your-domain>")
  $reader.ReadLine()

  $writer.WriteLine("DATA")
  $reader.ReadLine()

  $writer.WriteLine("Subject: test message")
  $writer.WriteLine("")
  $writer.WriteLine("hello from powershell")
  $writer.WriteLine(".")
  $reader.ReadLine()

  $writer.WriteLine("QUIT")
  $reader.ReadLine()
  $client.Close()
